import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import {
  getOrCreateGuildConfig,
  isAdmin,
  getEmployeeWeeklyTotal,
  getAllWeeklyTotals,
  formatMoney,
} from '../lib/helpers.js';
import { getWeekStart } from '../lib/week.js';

const selectedItems = new Map();

// Required so we can read the exact bytes Discord signed
export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function verifyDiscord(raw, sig, ts) {
  if (!sig || !ts) return false;
  try {
    const pub = process.env.DISCORD_PUBLIC_KEY;
    if (!pub) {
      console.error('Missing DISCORD_PUBLIC_KEY');
      return false;
    }
    // Same method as working HelpBet bot
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(pub, 'hex'),
    ]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(ts + raw), key, Buffer.from(sig, 'hex'));
  } catch (e) {
    console.error('verifyDiscord error', e);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const rawBody = await readRaw(req);

    const isValid = await verifyDiscord(rawBody, signature, timestamp);
    if (!isValid) {
      console.error('Invalid Discord signature');
      return res.status(401).send('Invalid request signature');
    }

    const interaction = JSON.parse(rawBody);

    // Discord endpoint verification ping
    if (interaction.type === 1) {
      return res.status(200).json({ type: 1 }); // PONG
    }

    // APPLICATION COMMAND
    if (interaction.type === 2) {
      const { name, options } = interaction.data;
      const guildId = interaction.guild_id;
      const memberRoles = interaction.member?.roles || [];

      if (name === 'setup') {
        const sub = options?.[0]?.name;
        // Server owners/admins can always run /setup, so a fresh server isn't locked out
        const perms = BigInt(interaction.member?.permissions || '0');
        const hasServerPerms = (perms & 0x8n) !== 0n || (perms & 0x20n) !== 0n; // Administrator | Manage Server
        await getOrCreateGuildConfig(guildId); // make sure the config row exists
        if (!hasServerPerms && !(await isAdmin(memberRoles, guildId))) {
          return res.status(200).json({
            type: 4,
            data: { content: 'No permission.', flags: 64 },
          });
        }

        if (sub === 'admin-panel') {
          const panel = await buildAdminPanel(guildId);
          return res.status(200).json({
            type: 4,
            data: panel,
          });
        }

        if (sub === 'logs-channel') {
          const channelOpt = options[0].options?.find(o => o.name === 'channel');
          const channelId = channelOpt?.value;
          if (!channelId) {
            return res.status(200).json({
              type: 4,
              data: { content: 'Please provide a channel.', flags: 64 },
            });
          }
          const msg = await setLogsChannel(guildId, channelId);
          return res.status(200).json({ type: 4, data: { content: msg, flags: 64 } });
        }

        if (sub === 'employee') {
          const o = options[0].options || [];
          const u = o.find(x => x.name === 'user')?.value;
          const c = o.find(x => x.name === 'channel')?.value;
          const msg = await linkEmployee(guildId, u, c);
          return res.status(200).json({ type: 4, data: { content: msg, flags: 64 } });
        }

        if (sub === 'admin-roles') {
          const roles = (options[0].options || [])
            .filter(o => o.name.startsWith('role'))
            .map(o => o.value);

          await supabase
            .from('guild_config')
            .update({ admin_role_ids: roles, updated_at: new Date().toISOString() })
            .eq('guild_id', guildId);

          return res.status(200).json({
            type: 4,
            data: {
              content: `Admin roles updated: ${roles.map(id => `<@&${id}>`).join(', ')}`,
              flags: 64,
            },
          });
        }
      }

      if (name === 'items') {
        if (!(await isAdmin(memberRoles, guildId))) {
          return res.status(200).json({
            type: 4,
            data: { content: 'No permission.', flags: 64 },
          });
        }

        const sub = options?.[0]?.name;

        if (sub === 'add') {
          const nameOpt = options[0].options.find(o => o.name === 'name');
          const emojiOpt = options[0].options.find(o => o.name === 'emoji');
          const itemName = nameOpt.value;
          const emoji = emojiOpt?.value || '🍹';

          await supabase.from('craftable_items').upsert(
            { guild_id: guildId, name: itemName, emoji, active: true },
            { onConflict: 'guild_id,name' }
          );

          return res.status(200).json({
            type: 4,
            data: { content: `Added **${emoji} ${itemName}**`, flags: 64 },
          });
        }

        if (sub === 'list') {
          const { data } = await supabase
            .from('craftable_items')
            .select('name, emoji, active')
            .eq('guild_id', guildId)
            .order('name');

          if (!data?.length) {
            return res.status(200).json({
              type: 4,
              data: { content: 'No items yet. Use `/items add`', flags: 64 },
            });
          }

          const lines = data.map(i => `${i.active ? '✅' : '❌'} ${i.emoji || '🍹'} ${i.name}`);
          return res.status(200).json({
            type: 4,
            data: { content: lines.join('\n'), flags: 64 },
          });
        }

        if (sub === 'remove') {
          const nameOpt = options[0].options.find(o => o.name === 'name');
          await supabase
            .from('craftable_items')
            .update({ active: false })
            .eq('guild_id', guildId)
            .eq('name', nameOpt.value);

          return res.status(200).json({
            type: 4,
            data: { content: `Deactivated **${nameOpt.value}**`, flags: 64 },
          });
        }
      }
    }

    // MESSAGE COMPONENTS (type 3)
    if (interaction.type === 3) {
      const customId = interaction.data.custom_id;
      const guildId = interaction.guild_id;
      const userId = interaction.member?.user?.id || interaction.user?.id;
      const memberRoles = interaction.member?.roles || [];

      if (customId === 'admin_refresh') {
        if (!(await isAdmin(memberRoles, guildId))) {
          return res.status(200).json({
            type: 4,
            data: { content: 'No permission.', flags: 64 },
          });
        }
        const panel = await buildAdminPanel(guildId);
        return res.status(200).json({
          type: 7, // UPDATE_MESSAGE
          data: panel,
        });
      }

      if (customId === 'admin_set_employee' || customId === 'admin_set_logs') {
        if (!(await canAdmin(interaction))) {
          return res.status(200).json({ type: 4, data: { content: 'No permission.', flags: 64 } });
        }
        const isEmp = customId === 'admin_set_employee';
        const channelPicker = {
          type: 18,
          label: isEmp ? 'Their sales channel' : 'Logs channel',
          component: {
            type: 8,
            custom_id: 'channel',
            channel_types: [0],
            min_values: 1,
            max_values: 1,
            required: true,
            placeholder: 'Search for a channel',
          },
        };
        const userPicker = {
          type: 18,
          label: 'Employee',
          component: {
            type: 5,
            custom_id: 'user',
            min_values: 1,
            max_values: 1,
            required: true,
            placeholder: 'Search for a user',
          },
        };
        return res.status(200).json({
          type: 9,
          data: {
            custom_id: isEmp ? 'modal_emp_pick' : 'modal_logs_pick',
            title: isEmp ? 'Set Employee' : 'Set Logs Channel',
            components: isEmp ? [userPicker, channelPicker] : [channelPicker],
          },
        });
      }

      if (customId.startsWith('logpanel_open_')) {
        const target = customId.replace('logpanel_open_', '');
        if (userId !== target) {
          return res.status(200).json({ type: 4, data: { content: 'This is not your panel.', flags: 64 } });
        }
        const { data: items } = await supabase
          .from('craftable_items')
          .select('id, name, emoji')
          .eq('guild_id', guildId)
          .eq('active', true)
          .order('name')
          .limit(25);
        if (!items?.length) {
          return res.status(200).json({
            type: 4,
            data: { content: 'No items yet. An admin can add some with `/items add`.', flags: 64 },
          });
        }
        return res.status(200).json({
          type: 9,
          data: {
            custom_id: `modal_logitem_${userId}`,
            title: 'Log Crafted Items',
            components: [
              {
                type: 18,
                label: 'Item',
                component: {
                  type: 3,
                  custom_id: 'item',
                  required: true,
                  placeholder: 'Pick an item',
                  options: items.map(i => ({
                    label: `${i.emoji && !i.emoji.startsWith('<') ? i.emoji + ' ' : ''}${i.name}`.slice(0, 100),
                    value: String(i.id),
                  })),
                },
              },
              {
                type: 18,
                label: 'How many did you craft?',
                component: { type: 4, custom_id: 'quantity', style: 1, required: true, placeholder: 'e.g. 25' },
              },
            ],
          },
        });
      }

      if (customId === 'admin_set_employee_legacy') {
        if (!(await isAdmin(memberRoles, guildId))) {
          return res.status(200).json({
            type: 4,
            data: { content: 'No permission.', flags: 64 },
          });
        }
        return res.status(200).json({
          type: 9, // MODAL
          data: {
            custom_id: 'modal_set_employee',
            title: 'Set Employee Sales Channel',
            components: [
              {
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'user_id',
                  label: 'User ID or @mention',
                  style: 1,
                  required: true,
                }],
              },
              {
                type: 1,
                components: [{
                  type: 4,
                  custom_id: 'channel_id',
                  label: 'Sales Channel ID (blank = create later)',
                  style: 1,
                  required: false,
                }],
              },
            ],
          },
        });
      }

      if (customId === 'admin_pay_all') {
        if (!(await isAdmin(memberRoles, guildId))) {
          return res.status(200).json({
            type: 4,
            data: { content: 'No permission.', flags: 64 },
          });
        }
        return res.status(200).json({
          type: 4,
          data: {
            content: 'Pay check started. Results will appear in sales channels / logs.',
            flags: 64,
          },
        });
      }

      if (customId.startsWith('log_select_item_')) {
        const targetUser = customId.replace('log_select_item_', '');
        if (userId !== targetUser) {
          return res.status(200).json({
            type: 4,
            data: { content: 'This is not your panel.', flags: 64 },
          });
        }
        const itemId = interaction.data.values[0];
        selectedItems.set(userId, itemId);

        return res.status(200).json({
          type: 4,
          data: {
            content: 'Selected item. Now click **Log Amount**.',
            flags: 64,
          },
        });
      }

      if (customId.startsWith('log_open_modal_')) {
        const targetUser = customId.replace('log_open_modal_', '');
        if (userId !== targetUser) {
          return res.status(200).json({
            type: 4,
            data: { content: 'This is not your panel.', flags: 64 },
          });
        }
        const selected = selectedItems.get(userId);
        if (!selected) {
          return res.status(200).json({
            type: 4,
            data: { content: 'Select an item first.', flags: 64 },
          });
        }

        return res.status(200).json({
          type: 9,
          data: {
            custom_id: `modal_log_amount_${userId}_${selected}`,
            title: 'Log Crafted Amount',
            components: [{
              type: 1,
              components: [{
                type: 4,
                custom_id: 'quantity',
                label: 'How many did you craft?',
                style: 1,
                placeholder: 'e.g. 25',
                required: true,
              }],
            }],
          },
        });
      }
    }

    // MODAL SUBMIT (type 5)
    if (interaction.type === 5) {
      const customId = interaction.data.custom_id;
      const guildId = interaction.guild_id;
      const userId = interaction.member?.user?.id || interaction.user?.id;
      const fields = interaction.data.components;

      const getField = (id) => {
        for (const row of fields) {
          const cs = row.component ? [row.component] : (row.components || []);
          for (const c of cs) {
            if (c.custom_id === id) return c.value ?? (c.values ? c.values[0] : null);
          }
        }
        return null;
      };

      if (customId === 'modal_emp_pick' || customId === 'modal_logs_pick') {
        if (!(await canAdmin(interaction))) {
          return res.status(200).json({ type: 4, data: { content: 'No permission.', flags: 64 } });
        }
        const channelId = getField('channel');
        const msg = customId === 'modal_emp_pick'
          ? await linkEmployee(guildId, getField('user'), channelId)
          : await setLogsChannel(guildId, channelId);
        return res.status(200).json({ type: 4, data: { content: msg, flags: 64 } });
      }

      if (customId.startsWith('modal_logitem_')) {
        const targetUser = customId.replace('modal_logitem_', '');
        if (userId !== targetUser) {
          return res.status(200).json({ type: 4, data: { content: 'Not your log.', flags: 64 } });
        }
        const itemId = getField('item');
        const quantity = parseInt(getField('quantity'), 10);
        if (isNaN(quantity) || quantity < 1) {
          return res.status(200).json({ type: 4, data: { content: 'Invalid quantity.', flags: 64 } });
        }
        const { data: item } = await supabase
          .from('craftable_items')
          .select('name, emoji')
          .eq('id', itemId)
          .single();
        if (!item) {
          return res.status(200).json({ type: 4, data: { content: 'Item not found.', flags: 64 } });
        }
        const weekStart = getWeekStart();
        await supabase.from('crafting_logs').insert({
          guild_id: guildId,
          user_id: userId,
          item_id: itemId,
          item_name: item.name,
          quantity,
          week_start: weekStart,
          logged_by: userId,
        });
        const newTotal = await getEmployeeWeeklyTotal(guildId, userId, weekStart);
        const cfg = await getOrCreateGuildConfig(guildId);
        if (cfg.logs_channel_id) {
          discordPost(cfg.logs_channel_id, {
            embeds: [{
              color: 0xFF69B4,
              description: `<@${userId}> logged **${quantity}x ${item.name}** — weekly total **${newTotal}**`,
              timestamp: new Date().toISOString(),
            }],
            allowed_mentions: { parse: [] },
          }).catch(e => console.error('log post failed', e.message));
        }
        return res.status(200).json({
          type: 4,
          data: { content: `Logged **${quantity}x ${item.name}**. Your weekly total is now **${newTotal}**.`, flags: 64 },
        });
      }

      if (customId === 'modal_set_employee') {
        const userInput = getField('user_id') || '';
        const channelInput = getField('channel_id') || '';
        const match = userInput.match(/\d{17,20}/);
        if (!match) {
          return res.status(200).json({
            type: 4,
            data: { content: 'Invalid user ID.', flags: 64 },
          });
        }
        const targetUserId = match[0];
        let salesChannelId = channelInput.trim() || null;

        await supabase.from('employees').upsert(
          {
            guild_id: guildId,
            user_id: targetUserId,
            sales_channel_id: salesChannelId,
            active: true,
          },
          { onConflict: 'guild_id,user_id' }
        );

        return res.status(200).json({
          type: 4,
          data: {
            content: salesChannelId
              ? `Employee <@${targetUserId}> linked to <#${salesChannelId}>.`
              : `Employee <@${targetUserId}> saved. Provide a sales channel ID next time.`,
            flags: 64,
          },
        });
      }

      if (customId.startsWith('modal_log_amount_')) {
        const parts = customId.replace('modal_log_amount_', '').split('_');
        const targetUser = parts[0];
        const itemId = parts[1];

        if (userId !== targetUser) {
          return res.status(200).json({
            type: 4,
            data: { content: 'Not your log.', flags: 64 },
          });
        }

        const quantity = parseInt(getField('quantity'), 10);
        if (isNaN(quantity) || quantity < 1) {
          return res.status(200).json({
            type: 4,
            data: { content: 'Invalid quantity.', flags: 64 },
          });
        }

        const weekStart = getWeekStart();
        const { data: item } = await supabase
          .from('craftable_items')
          .select('name, emoji')
          .eq('id', itemId)
          .single();

        if (!item) {
          return res.status(200).json({
            type: 4,
            data: { content: 'Item not found.', flags: 64 },
          });
        }

        await supabase.from('crafting_logs').insert({
          guild_id: guildId,
          user_id: userId,
          item_id: itemId,
          item_name: item.name,
          quantity,
          week_start: weekStart,
          logged_by: userId,
        });

        const newTotal = await getEmployeeWeeklyTotal(guildId, userId, weekStart);
        selectedItems.delete(userId);

        return res.status(200).json({
          type: 4,
          data: {
            content: `Logged **${quantity}x ${item.name}**. Your weekly total is now **${newTotal}**.`,
            flags: 64,
          },
        });
      }
    }

    return res.status(200).json({
      type: 4,
      data: { content: 'Unhandled interaction.', flags: 64 },
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(200).json({
      type: 4,
      data: { content: 'Something went wrong.', flags: 64 },
    });
  }
}

async function buildAdminPanel(guildId) {
  const config = await getOrCreateGuildConfig(guildId);
  const weekStart = getWeekStart();
  const totals = await getAllWeeklyTotals(guildId, weekStart);

  const { data: employees } = await supabase
    .from('employees')
    .select('user_id, sales_channel_id, active')
    .eq('guild_id', guildId)
    .eq('active', true);

  const quota = config.quota_amount || 600;
  const basePay = config.pay_base || 100000;
  const bonusPay = config.pay_bonus || 150000;

  let statusLines = [];
  if (employees?.length) {
    for (const emp of employees) {
      const total = totals[emp.user_id] || 0;
      let status;
      if (total >= quota) {
        status = `✅ Quota hit (${total}) → ${formatMoney(total > quota ? bonusPay : basePay)}`;
      } else if (total >= quota - (config.close_threshold || 150)) {
        status = `⚠️ Close (${total}/${quota})`;
      } else {
        status = `❌ ${total}/${quota}`;
      }
      statusLines.push(`<@${emp.user_id}> — ${status}`);
    }
  } else {
    statusLines.push('*No employees set up yet*');
  }

  const embed = {
    title: '🍬 Candy Shop — Admin Panel',
    color: 0xFF69B4,
    description:
      `**Current Week** (starts ${weekStart})\n` +
      `Quota: **${quota}** items\n` +
      `Base Pay: **${formatMoney(basePay)}** | Bonus: **${formatMoney(bonusPay)}**\n\n` +
      `**Employee Status**\n` +
      statusLines.join('\n'),
    footer: { text: 'Use the buttons below' },
    timestamp: new Date().toISOString(),
  };

  const components = [{
    type: 1,
    components: [
      { type: 2, custom_id: 'admin_set_employee', label: 'Set Employee', style: 1, emoji: { name: '👤' } },
      { type: 2, custom_id: 'admin_set_logs', label: 'Set Logs Channel', style: 1, emoji: { name: '📜' } },
      { type: 2, custom_id: 'admin_pay_all', label: 'Run Pay Check', style: 3, emoji: { name: '💰' } },
      { type: 2, custom_id: 'admin_refresh', label: 'Refresh', style: 2, emoji: { name: '🔄' } },
    ],
  }];

  return { embeds: [embed], components };
}

// ---------- helpers ----------

async function canAdmin(interaction) {
  const perms = BigInt(interaction.member?.permissions || '0');
  if ((perms & 0x8n) !== 0n || (perms & 0x20n) !== 0n) return true; // Administrator | Manage Server
  return isAdmin(interaction.member?.roles || [], interaction.guild_id);
}

async function discordPost(channelId, body) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
  return r.json();
}

function buildLogPanel(userId) {
  return {
    content: `<@${userId}>`,
    embeds: [{
      title: '🍬 Candy Shop — Log Your Crafts',
      color: 0xFF69B4,
      description: 'Click **Log Items**, pick what you crafted, and enter how many.\nThis panel is just for you.',
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, custom_id: `logpanel_open_${userId}`, label: 'Log Items', style: 3, emoji: { name: '🍬' } },
      ],
    }],
  };
}

async function linkEmployee(guildId, userId, channelId) {
  if (!userId || !channelId) return 'Pick both a user and a channel.';
  await getOrCreateGuildConfig(guildId);
  await supabase.from('employees').upsert(
    { guild_id: guildId, user_id: userId, sales_channel_id: channelId, active: true },
    { onConflict: 'guild_id,user_id' }
  );
  try {
    await discordPost(channelId, buildLogPanel(userId));
    return `✅ <@${userId}> linked to <#${channelId}> and the logging panel was sent there.`;
  } catch (e) {
    console.error('panel post failed', e.message);
    return `<@${userId}> linked to <#${channelId}>, but I couldn't post the panel. Give the bot View Channel, Send Messages and Embed Links there, then set it again.`;
  }
}

async function setLogsChannel(guildId, channelId) {
  if (!channelId) return 'Pick a channel.';
  await getOrCreateGuildConfig(guildId);
  await supabase
    .from('guild_config')
    .update({ logs_channel_id: channelId, updated_at: new Date().toISOString() })
    .eq('guild_id', guildId);
  try {
    await discordPost(channelId, await buildAdminPanel(guildId));
    return `✅ Logs channel set to <#${channelId}> and the panel was sent there.`;
  } catch (e) {
    console.error('panel post failed', e.message);
    return `Logs channel set to <#${channelId}>, but I couldn't post the panel. Give the bot View Channel, Send Messages and Embed Links there, then set it again.`;
  }
}
