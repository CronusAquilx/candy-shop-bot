import { supabase } from './supabase.js';
import { getAllWeeklyTotals, formatMoney, getOrCreateGuildConfig } from './helpers.js';

async function post(channelId, body) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
}

// Works out each employee's result for a week and posts it to the logs channel.
export async function runPayCheck(guildId, weekStart, { note = '' } = {}) {
  const config = await getOrCreateGuildConfig(guildId);
  if (!config.logs_channel_id) return { ok: false, reason: 'no-logs-channel' };

  const quota = config.quota_amount || 600;
  const basePay = config.pay_base || 100000;
  const bonusPay = config.pay_bonus || 150000;
  const close = config.close_threshold || 150;

  const totals = await getAllWeeklyTotals(guildId, weekStart);
  const { data: employees } = await supabase
    .from('employees')
    .select('user_id')
    .eq('guild_id', guildId)
    .eq('active', true);

  await post(config.logs_channel_id, {
    embeds: [{
      title: `💰 Pay Check — week of ${weekStart}${note}`,
      color: 0xFF69B4,
      description: employees?.length ? `Quota: **${quota}** items` : '*No employees set up yet*',
    }],
  });

  for (const emp of employees || []) {
    const total = totals[emp.user_id] || 0;
    let message;
    if (total >= quota) {
      const pay = total > quota ? bonusPay : basePay;
      message =
        `✅ Quota reached! Crafted **${total}** items.\n` +
        `Owed **${formatMoney(pay)}**.\nShop billed **${formatMoney(pay)}**.`;
    } else if (total >= quota - close) {
      message = `⚠️ Quota not reached (${total}/${quota}).\nTalk to **Phoenix** or **Lu** about pay.`;
    } else {
      message = `❌ Quota not reached (${total}/${quota}).`;
    }
    await post(config.logs_channel_id, { content: `<@${emp.user_id}>\n${message}` });
  }

  return { ok: true, count: employees?.length || 0 };
}
