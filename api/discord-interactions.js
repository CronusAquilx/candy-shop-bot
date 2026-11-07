import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { runPayCheck } from '../lib/pay.js';
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
          await ensureDefaultItems(guildId);
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
        await ensureDefaultItems(guildId);
        const { data: items } = await supabase
          .from('craftable_items')
          .select('id, name, emoji')
          .eq('guild_id', guildId)
          .eq('active', true)
          .eq('box_only', false)
          .order('name')
          .limit(25);
        if (!items?.length) {
          return res.status(200).json({
            type: 4,
            data: { content: 'No items yet. An admin can add some with `/items add`.', flags: 64 },
          });
        }
        return res.status(200).json({
          type: 4,
          data: {
            content: 'What did you craft?',
            flags: 64,
            components: [{
              type: 1,
              components: [{
                type: 3,
                custom_id: `logpick_${userId}`,
                placeholder: 'Pick an item',
                options: items.map(i => ({
                  label: `${itemEmoji(i)}${i.name}`.slice(0, 100),
                  value: String(i.id),
                })),
              }],
            }],
          },
        });
      }

      if (customId.startsWith('logpick_')) {
        const target = customId.replace('logpick_', '');
        if (userId !== target) {
          return res.status(200).json({ type: 4, data: { content: 'This is not your panel.', flags: 64 } });
        }
        const itemId = interaction.data.values[0];
        const { data: item } = await supabase
          .from('craftable_items')
          .select('id, name, emoji')
          .eq('id', itemId)
          .single();
        if (!item) {
          return res.status(200).json({ type: 4, data: { content: 'Item not found.', flags: 64 } });
        }

        // Boxes expands into the drinks that went in them
        if (item.name.toLowerCase() === 'boxes') {
          const { data: drinks } = await supabase
            .from('craftable_items')
            .select('id, name, emoji')
            .eq('guild_id', guildId)
            .eq('active', true)
            .eq('box_only', true)
            .order('name')
            .limit(4);
          return res.status(200).json({
            type: 9,
            data: {
              custom_id: `modal_bxA_${userId}_${item.id}`,
              title: 'Log Boxes',
              components: [
                {
                  type: 18,
                  label: 'How many boxes?',
                  component: { type: 4, custom_id: 'boxes', style: 1, required: true, placeholder: 'e.g. 20' },
                },
                ...(drinks || []).map(d => ({
                  type: 18,
                  label: `${itemEmoji(d)}${d.name}`.slice(0, 45),
                  description: 'How many of this drink were made (blank = 0)',
                  component: { type: 4, custom_id: `d_${d.id}`, style: 1, required: false, placeholder: '0' },
                })),
              ],
            },
          });
        }

        return res.status(200).json({
          type: 9,
          data: {
            custom_id: `modal_logitem_${userId}_${item.id}`,
            title: `Log ${item.name}`.slice(0, 45),
            components: [
              {
                type: 18,
                label: 'How many did you craft?',
                component: { type: 4, custom_id: 'quantity', style: 1, required: true, placeholder: 'e.g. 25' },
              },
              {
                type: 18,
                label: 'Screenshots (1-3)',
                description: 'Upload 1 to 3 screenshots of what you crafted',
                component: { type: 19, custom_id: 'shots', min_values: 1, max_values: 3, required: true },
              },
            ],
          },
        });
      }

      if (customId.startsWith('bxshots_')) {
        const rest = customId.replace('bxshots_', '');
        if (userId !== rest.split('_')[0]) {
          return res.status(200).json({ type: 4, data: { content: 'This is not your log.', flags: 64 } });
        }
        return res.status(200).json({
          type: 9,
          data: {
            custom_id: `modal_bxB_${rest}`,
            title: 'Upload Screenshots',
            components: [{
              type: 18,
              label: 'Screenshots (1-3)',
              description: 'Upload 1 to 3 screenshots of what you crafted',
              component: { type: 19, custom_id: 'shots', min_values: 1, max_values: 3, required: true },
            }],
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
        if (!(await canAdmin(interaction))) {
          return res.status(200).json({ type: 4, data: { content: 'No permission.', flags: 64 } });
        }
        // Reply right away (Discord needs an answer in 3s), finish posting in the background
        waitUntil(
          runPayCheck(guildId, getWeekStart(), { note: ' (manual run)' })
            .catch(e => console.error('manual pay check failed', e.message))
        );
        return res.status(200).json({
          type: 4,
          data: { content: 'Pay check running. Each person\'s result is being sent to their own sales channel.', flags: 64 },
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

      const getValues = (id) => {
        for (const row of fields) {
          const cs = row.component ? [row.component] : (row.components || []);
          for (const c of cs) if (c.custom_id === id) return c.values || [];
        }
        return [];
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

      if (customId.startsWith('modal_bxA_')) {
        const [targetUser, boxItemId] = customId.replace('modal_bxA_', '').split('_');
        if (userId !== targetUser) {
          return res.status(200).json({ type: 4, data: { content: 'Not your log.', flags: 64 } });
        }
        const boxes = parseInt(getField('boxes'), 10);
        if (isNaN(boxes) || boxes < 1) {
          return res.status(200).json({ type: 4, data: { content: 'Enter how many boxes you made.', flags: 64 } });
        }
        const pairs = [];
        for (const row of fields) {
          const c = row.component || row.components?.[0];
          if (!c?.custom_id?.startsWith('d_')) continue;
          const q = parseInt(c.value, 10);
          if (!isNaN(q) && q > 0) pairs.push(`${c.custom_id.slice(2)}.${q}`);
        }
        const encoded = pairs.join('-') || 'none';
        const { data: names } = await supabase
          .from('craftable_items')
          .select('id, name, emoji')
          .in('id', pairs.map(x => x.split('.')[0]));
        const lines = pairs.map(x => {
          const [id, q] = x.split('.');
          const d = names?.find(n => String(n.id) === id);
          return `${itemEmoji(d || {})}${d?.name || 'Drink'} — **${q}x**`;
        });
        return res.status(200).json({
          type: 4,
          data: {
            content: `📦 **${boxes}x Boxes**\n${lines.join('\n') || '*No drinks entered*'}\n\nLast step: upload your screenshots.`,
            flags: 64,
            components: [{
              type: 1,
              components: [{
                type: 2,
                custom_id: `bxshots_${userId}_${boxItemId}_${boxes}_${encoded}`,
                label: 'Upload screenshots',
                style: 3,
                emoji: { name: '📸' },
              }],
            }],
          },
        });
      }

      if (customId.startsWith('modal_bxB_')) {
        const [targetUser, boxItemId, boxesStr, encoded] = customId.replace('modal_bxB_', '').split('_');
        if (userId !== targetUser) {
          return res.status(200).json({ type: 4, data: { content: 'Not your log.', flags: 64 } });
        }
        const boxes = parseInt(boxesStr, 10);
        const pairs = encoded === 'none' ? [] : encoded.split('-').map(x => x.split('.'));
        const ids = [boxItemId, ...pairs.map(p => p[0])];
        const { data: rows } = await supabase
          .from('craftable_items')
          .select('id, name, emoji')
          .in('id', ids);
        const byId = Object.fromEntries((rows || []).map(r => [String(r.id), r]));
        const boxItem = byId[boxItemId];
        if (!boxItem) {
          return res.status(200).json({ type: 4, data: { content: 'Item not found.', flags: 64 } });
        }
        const weekStart = getWeekStart();
        const inserts = [{ id: boxItemId, qty: boxes }, ...pairs.map(p => ({ id: p[0], qty: parseInt(p[1], 10) }))]
          .filter(x => byId[x.id] && x.qty > 0)
          .map(x => ({
            guild_id: guildId,
            user_id: userId,
            item_id: x.id,
            item_name: byId[x.id].name,
            quantity: x.qty,
            week_start: weekStart,
            logged_by: userId,
          }));
        await supabase.from('crafting_logs').insert(inserts);

        const newTotal = await getEmployeeWeeklyTotal(guildId, userId, weekStart);
        const cfg = await getOrCreateGuildConfig(guildId);
        const { data: emp } = await supabase
          .from('employees')
          .select('sales_channel_id')
          .eq('guild_id', guildId)
          .eq('user_id', userId)
          .maybeSingle();
        const resolved = interaction.data.resolved?.attachments || {};
        const shots = getValues('shots').map(id => resolved[id]).filter(Boolean).slice(0, 3);
        const lines = [
          `📦 **${boxes}x Boxes**`,
          ...pairs.map(p => `↳ ${itemEmoji(byId[p[0]] || {})}${byId[p[0]]?.name || 'Drink'} — **${p[1]}x**`),
        ];

        waitUntil(
          announceLog({
            userId,
            item: boxItem,
            quantity: boxes,
            lines,
            total: newTotal,
            quota: cfg.quota_amount || 600,
            channelId: emp?.sales_channel_id || interaction.channel_id,
            logsChannelId: cfg.logs_channel_id,
            shots,
          }).catch(e => console.error('announce failed', e.message))
        );

        return res.status(200).json({
          type: 4,
          data: {
            content: `Logged **${boxes}x Boxes** and their drinks. Your total is now **${newTotal}**. Posting it to your sales channel.`,
            flags: 64,
          },
        });
      }

      if (customId.startsWith('modal_logitem_')) {
        const [targetUser, itemId] = customId.replace('modal_logitem_', '').split('_');
        if (userId !== targetUser) {
          return res.status(200).json({ type: 4, data: { content: 'Not your log.', flags: 64 } });
        }
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
        const { data: emp } = await supabase
          .from('employees')
          .select('sales_channel_id')
          .eq('guild_id', guildId)
          .eq('user_id', userId)
          .maybeSingle();
        const resolved = interaction.data.resolved?.attachments || {};
        const shots = getValues('shots').map(id => resolved[id]).filter(Boolean).slice(0, 3);

        // Post to their sales channel (and the logs channel) after replying, Discord needs an answer in 3s
        waitUntil(
          announceLog({
            userId,
            item,
            quantity,
            total: newTotal,
            quota: cfg.quota_amount || 600,
            channelId: emp?.sales_channel_id || interaction.channel_id,
            logsChannelId: cfg.logs_channel_id,
            shots,
          }).catch(e => console.error('announce failed', e.message))
        );

        return res.status(200).json({
          type: 4,
          data: {
            content: `Logged **${quantity}x ${item.name}**. Your total is now **${newTotal}**. Posting it to your sales channel.`,
            flags: 64,
          },
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
  await ensureDefaultItems(guildId);
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
  await ensureDefaultItems(guildId);
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

const DEFAULT_ITEMS = [
  { name: 'Phoenix BJ Shot', emoji: '🥃', box_only: true },
  { name: 'Bricked Up Shot', emoji: '🥃', box_only: true },
  { name: 'Lus Naughty N…', emoji: '🍹', box_only: true },
  { name: 'Midnight Hazy…', emoji: '🍹', box_only: true },
  { name: 'Strawberry C…', emoji: '🍹' },
  { name: 'Cinnamon Myx…', emoji: '🍹' },
  { name: 'Cowbell Crun…', emoji: '🍹' },
  { name: 'Boxes', emoji: '📦' },
];

// Adds the default Candy Shop items the first time a server has none
async function ensureDefaultItems(guildId) {
  const { count } = await supabase
    .from('craftable_items')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId);
  if (count > 0) return;
  await supabase.from('craftable_items').upsert(
    DEFAULT_ITEMS.map(i => ({ guild_id: guildId, name: i.name, emoji: i.emoji, active: true, box_only: !!i.box_only })),
    { onConflict: 'guild_id,name' }
  );
}

async function announceLog({ userId, item, quantity, lines = null, total, quota, channelId, logsChannelId, shots }) {
  const left = quota - total;
  const progress = left <= 0
    ? `✅ Quota reached! (**${total}/${quota}**)`
    : `**${left}** more to reach quota (**${total}/${quota}**)`;
  const embed = {
    title: '🍬 Crafting Logged',
    color: 0xFF69B4,
    description: lines
      ? `<@${userId}> crafted:\n${lines.join('\n')}`
      : `<@${userId}> crafted **${quantity}x ${itemEmoji(item)}${item.name}**`,
    fields: [{ name: 'Progress', value: progress }],
    footer: { text: 'Click below to log more' },
    timestamp: new Date().toISOString(),
  };
  const components = [{
    type: 1,
    components: [
      { type: 2, custom_id: `logpanel_open_${userId}`, label: 'Log Items Again', style: 3, emoji: { name: '🍬' } },
    ],
  }];

  // Re-upload the screenshots so they stay visible (Discord's upload links expire)
  const files = [];
  const failed = [];
  for (const [i, a] of shots.entries()) {
    try {
      const r = await fetch(a.url);
      if (!r.ok) throw new Error(`status ${r.status}`);
      files.push({ name: `screenshot${i + 1}-${a.filename || 'image.png'}`, blob: await r.blob() });
    } catch (e) {
      console.error('screenshot download failed', e.message);
      failed.push(a.url);
    }
  }
  if (failed.length) embed.fields.push({ name: 'Screenshots', value: failed.join('\n') });

  const payload = { embeds: [embed], components, allowed_mentions: { parse: [] } };
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  files.forEach((f, i) => form.append(`files[${i}]`, f.blob, f.name));
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);

  if (logsChannelId && logsChannelId !== channelId) {
    await discordPost(logsChannelId, {
      embeds: [{
        color: 0xFF69B4,
        description: `<@${userId}> logged ${lines ? `**${quantity}x ${item.name}** (with drinks)` : `**${quantity}x ${item.name}**`} — total **${total}/${quota}**`,
        timestamp: new Date().toISOString(),
      }],
      allowed_mentions: { parse: [] },
    }).catch(e => console.error('logs post failed', e.message));
  }
}

function itemEmoji(i) {
  return i?.emoji && !i.emoji.startsWith('<') ? i.emoji + ' ' : '';
}
