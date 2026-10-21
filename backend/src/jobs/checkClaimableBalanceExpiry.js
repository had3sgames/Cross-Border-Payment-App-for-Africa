const db = require('../db');
const webhook = require('../services/webhook');
const logger = require('../utils/logger');
const { persistAndBroadcast } = require('../services/notificationInbox');
const { sendClaimableBalanceExpiringEmail } = require('../services/email');

const WARN_HOURS = parseInt(process.env.CLAIMABLE_BALANCE_WARN_HOURS || '24', 10);

async function notifyUser(userId, balanceId, expiresAt) {
  try {
    const { rows } = await db.query('SELECT email, full_name FROM users WHERE id = $1', [userId]);
    if (!rows[0]) return;
    await sendClaimableBalanceExpiringEmail(rows[0].email, rows[0].full_name, balanceId, expiresAt);
    logger.info('Expiry notification sent', { userId, balanceId });
  } catch (err) {
    logger.warn('Failed to send expiry notification email', { userId, balanceId, error: err.message });
  }
}

async function checkClaimableBalanceExpiry() {
  const { rows: expired } = await db.query(
    `UPDATE claimable_balances
     SET status = 'expired', updated_at = NOW()
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
     RETURNING id, balance_id, user_id, asset, amount`
  );

  for (const row of expired) {
    logger.info('Claimable balance expired', { balanceId: row.balance_id });
    webhook.deliver('claimable_balance.expired', row.user_id, {
      id: row.id,
      balance_id: row.balance_id,
      asset: row.asset,
      amount: row.amount,
    }).catch(() => {});

    if (row.user_id) {
      persistAndBroadcast(row.user_id, 'claimable_balance_expired', 'Claimable balance expired',
        `Your claimable balance ${row.balance_id} has expired`,
        { balance_id: row.balance_id, asset: row.asset, amount: row.amount }
      ).catch(() => {});
    }
  }

  // Claim each warning exactly once: mark and return in the same statement
  const { rows: expiringSoon } = await db.query(
    `UPDATE claimable_balances
     SET expiry_warning_sent_at = NOW()
     WHERE status = 'active'
       AND expiry_warning_sent_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at > NOW()
       AND expires_at <= NOW() + ($1 || ' hours')::interval
     RETURNING id, balance_id, user_id, asset, amount, expires_at`,
    [WARN_HOURS]
  );

  for (const row of expiringSoon) {
    webhook.deliver('claimable_balance.expiring_soon', row.user_id, {
      id: row.id,
      balance_id: row.balance_id,
      asset: row.asset,
      amount: row.amount,
      expires_at: row.expires_at,
    }).catch(() => {});

    if (row.user_id) {
      await notifyUser(row.user_id, row.balance_id, row.expires_at);
      persistAndBroadcast(row.user_id, 'claimable_balance_expiring', 'Claimable balance expiring soon',
        `Your claimable balance ${row.balance_id} will expire on ${new Date(row.expires_at).toUTCString()}`,
        { balance_id: row.balance_id, asset: row.asset, amount: row.amount, expires_at: row.expires_at }
      ).catch(() => {});
    }
  }

  if (expired.length > 0 || expiringSoon.length > 0) {
    logger.info('Claimable balance expiry check complete', {
      expired: expired.length,
      expiringSoon: expiringSoon.length,
    });
  }
}

module.exports = { checkClaimableBalanceExpiry };