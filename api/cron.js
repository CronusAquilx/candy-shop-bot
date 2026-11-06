import { supabase } from '../lib/supabase.js';
import { getWeekStart } from '../lib/week.js';
import { runPayCheck } from '../lib/pay.js';

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isMonday = new Date().getUTCDay() === 1;
  const force = req.query.force === '1';
  if (!isMonday && !force) {
    return res.status(200).json({ ok: true, message: 'Not Monday, skipped' });
  }

  // Pays everything logged and unpaid so far; totals reset as soon as it's paid
  const weekStart = getWeekStart();
  const { data: guilds } = await supabase.from('guild_config').select('guild_id');
  const results = [];

  for (const g of guilds || []) {
    const { data: already } = await supabase
      .from('weekly_pay_runs')
      .select('week_start')
      .eq('guild_id', g.guild_id)
      .eq('week_start', weekStart)
      .maybeSingle();
    if (already && !force) {
      results.push({ guild: g.guild_id, skipped: 'already paid' });
      continue;
    }
    try {
      const r = await runPayCheck(g.guild_id, weekStart);
      results.push({ guild: g.guild_id, ...r });
      if (r.ok) {
        await supabase
          .from('weekly_pay_runs')
          .upsert({ guild_id: g.guild_id, week_start: weekStart }, { onConflict: 'guild_id,week_start' });
      }
    } catch (e) {
      console.error('pay run failed', g.guild_id, e.message);
      results.push({ guild: g.guild_id, ok: false, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, weekStart, results });
}
