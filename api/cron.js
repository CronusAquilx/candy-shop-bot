import { supabase } from '../lib/supabase.js';
import { getPreviousWeekStart, getWeekStart } from '../lib/week.js';
import { getAllWeeklyTotals, formatMoney, getOrCreateGuildConfig } from '../lib/helpers.js';

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date();
  const isMonday = today.getUTCDay() === 1;
  if (!isMonday && req.query.force !== '1') {
    return res.status(200).json({ ok: true, message: 'Not Monday, skipped' });
  }

  const weekStart = getPreviousWeekStart();
  const { data: guilds } = await supabase.from('guild_config').select('guild_id');

  const results = [];

  for (const g of guilds || []) {
    const guildId = g.guild_id;
    const config = await getOrCreateGuildConfig(guildId);
    const totals = await getAllWeeklyTotals(guildId, weekStart);
    const quota = config.quota_amount || 600;
    const basePay = config.pay_base || 100000;
    const bonusPay = config.pay_bonus || 150000;
    const close = config.close_threshold || 150;

    const { data: employees } = await supabase
      .from('employees')
      .select('user_id, sales_channel_id')
      .eq('guild_id', guildId)
      .eq('active', true);

    for (const emp of employees || []) {
      const total = totals[emp.user_id] || 0;
      let message = '';
      if (total >= quota) {
        const pay = total > quota ? bonusPay : basePay;
        message = `✅ Quota reached! You crafted **${total}** items.\nYou are owed **${formatMoney(pay)}**.\nShop billed **${formatMoney(pay)}**.`;
      } else if (total >= quota - close) {
        message = `⚠️ Quota not reached (${total}/${quota}).\nTalk to **Phoenix** or **Lu** about pay.`;
      } else {
        message = `❌ Quota not reached (${total}/${quota}).`;
      }
      results.push({ user: emp.user_id, total, message });
    }

    await supabase.from('weekly_pay_runs').upsert(
      { guild_id: guildId, week_start: weekStart },
      { onConflict: 'guild_id,week_start' }
    );
  }

  return res.status(200).json({ ok: true, weekStart, resultsCount: results.length });
}
