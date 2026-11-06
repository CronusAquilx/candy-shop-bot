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

// Works out each employee's result for a week. Each person's announcement goes to
// their own sales channel; the logs channel gets a short summary of everyone.
export async function runPayCheck(guildId, weekStart, { note = '' } = {}) {
  const config = await getOrCreateGuildConfig(guildId);

  const quota = config.quota_amount || 600;
  const basePay = config.pay_base || 100000;
  const bonusPay = config.pay_bonus || 150000;
  const close = config.close_threshold || 150;

  const totals = await getAllWeeklyTotals(guildId, weekStart);
  const { data: employees } = await supabase
    .from('employees')
    .select('user_id, sales_channel_id')
    .eq('guild_id', guildId)
    .eq('active', true);

  const summary = [];
  let sent = 0;

  for (const emp of employees || []) {
    const total = totals[emp.user_id] || 0;
    let message;
    let line;
    if (total >= quota) {
      const pay = total > quota ? bonusPay : basePay;
      message =
        `✅ Quota reached! Crafted **${total}** items.\n` +
        `Owed **${formatMoney(pay)}**.\nShop billed **${formatMoney(pay)}**.`;
      line = `✅ ${total}/${quota} — owed ${formatMoney(pay)}`;
    } else if (total >= quota - close) {
      message = `⚠️ Quota not reached (${total}/${quota}).\nTalk to **Phoenix** or **Lu** about pay.`;
      line = `⚠️ ${total}/${quota} — close, talk to Phoenix/Lu`;
    } else {
      message = `❌ Quota not reached (${total}/${quota}).`;
      line = `❌ ${total}/${quota}`;
    }

    // Their own sales channel; fall back to the logs channel if it isn't set or fails
    const body = { content: `<@${emp.user_id}>\n${message}` };
    let delivered = false;
    for (const ch of [emp.sales_channel_id, config.logs_channel_id]) {
      if (!ch) continue;
      try {
        await post(ch, body);
        delivered = true;
        break;
      } catch (e) {
        console.error('pay post failed', ch, e.message);
      }
    }
    if (delivered) sent++;
    summary.push(`<@${emp.user_id}> — ${line}${delivered ? '' : ' (could not send)'}`);
  }

  if (config.logs_channel_id) {
    await post(config.logs_channel_id, {
      embeds: [{
        title: `💰 Pay Check — week of ${weekStart}${note}`,
        color: 0xFF69B4,
        description: summary.length ? summary.join('\n') : '*No employees set up yet*',
      }],
      allowed_mentions: { parse: [] },
    }).catch(e => console.error('summary post failed', e.message));
  }

  return { ok: true, count: employees?.length || 0, sent };
}
