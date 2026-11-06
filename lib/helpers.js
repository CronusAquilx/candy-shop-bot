import { supabase } from './supabase.js';
import { getWeekStart } from './week.js';

export async function getOrCreateGuildConfig(guildId) {
  const { data, error } = await supabase
    .from('guild_config')
    .select('*')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) throw error;
  if (data) return data;

  const { data: created, error: createErr } = await supabase
    .from('guild_config')
    .insert({ guild_id: guildId })
    .select()
    .single();

  if (createErr) throw createErr;
  return created;
}

export async function isAdmin(memberRoles, guildId) {
  const config = await getOrCreateGuildConfig(guildId);
  if (!config.admin_role_ids || config.admin_role_ids.length === 0) {
    return false;
  }
  return memberRoles.some(r => config.admin_role_ids.includes(r));
}

export async function getEmployeeWeeklyTotal(guildId, userId, weekStart = getWeekStart()) {
  const { data, error } = await supabase
    .from('crafting_logs')
    .select('quantity')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .is('paid_at', null);

  if (error) throw error;
  return (data || []).reduce((sum, row) => sum + row.quantity, 0);
}

export async function getAllWeeklyTotals(guildId, weekStart = getWeekStart()) {
  const { data, error } = await supabase
    .from('crafting_logs')
    .select('user_id, quantity')
    .eq('guild_id', guildId)
    .is('paid_at', null);

  if (error) throw error;

  const totals = {};
  for (const row of data || []) {
    totals[row.user_id] = (totals[row.user_id] || 0) + row.quantity;
  }
  return totals;
}

export function formatMoney(amount) {
  return `$${Number(amount).toLocaleString()}`;
}
