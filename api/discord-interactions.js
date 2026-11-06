import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';
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

// Critical for Discord signature verification on Vercel
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const rawBody = await readRaw(req);

    const isValid = verifyKey(
      rawBody,
      signature,
      timestamp,
      process.env.DISCORD_PUBLIC_KEY
    );

    if (!isValid) {
      console.error('Invalid Discord signature');
      return res.status(401).send('Invalid request signature');
    }

    const interaction = JSON.parse(rawBody);

    // Discord ping verification — must return type 1 (PONG)
    if (interaction.type === InteractionType.PING) {
      return res.status(200).json({ type: InteractionResponseType.PONG });
    }

    // APPLICATION COMMAND
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const { name, options } = interaction.data;
      const guildId = interaction.guild_id;
      const memberRoles = interaction.member?.roles || [];

      if (name === 'setup') {
        const sub = options?.[0]?.name;
        if (!(await isAdmin(memberRoles, guildId))) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: 'No permission.', flags: 64 },
          });
        }

        if (sub === 'admin-panel') {
          const panel = await buildAdminPanel(guildId);
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: panel,
          });
        }

        if (sub === 'logs-channel') {
          const channelOpt = options[0].options?.find(o => o.name === 'channel');
          const channelId = channelOpt?.value;
          if (!channelId) {
            return res.status(200).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: 'Please provide a channel.', flags: 64 },
            });
          }
          await supabase
            .from('guild_config')
            .update({ logs_channel_id: channelId, updated_at: new Date().toISOString() })
            .eq('guild_id', guildId);

          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `Logs channel set to <#${channelId}>`, flags: 64 },
          });
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
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: 'No items yet. Use `/items add`', flags: 64 },
            });
          }

          const lines = data.map(i => `${i.active ? '✅' : '❌'} ${i.emoji || '🍹'} ${i.name}`);
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `Deactivated **${nameOpt.value}**`, flags: 64 },
          });
        }
      }
    }

    // MESSAGE COMPONENTS
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      const customId = interaction.data.custom_id;
      const guildId = interaction.guild_id;
      const userId = interaction.member?.user?.id || interaction.user?.id;
      const memberRoles = interaction.member?.roles || [];

      if (customId === 'admin_refresh') {
        if (!(await isAdmin(memberRoles, guildId))) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: 'No permission.', flags: 64 },
          });
        }
        const panel = await buildAdminPanel(guildId);
        return res.status(200).json({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: panel,
        });
      }

      if (customId === 'admin_set_employee') {
        if (!(await isAdmin(memberRoles, guildId))) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: 'No permission.', flags: 64 },
          });
        }
        return res.status(200).json({
          type: InteractionResponseType.MODAL,
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
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: 'No permission.', flags: 64 },
          });
        }
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: 'This is not your panel.', flags: 64 },
          });
        }
        const itemId = interaction.data.values[0];
        selectedItems.set(userId, itemId);

        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: 'This is not your panel.', flags: 64 },
          });
        }
        const selected = selectedItems.get(userId);
        if (!selected) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: 'Select an item first.', flags: 64 },
          });
        }

        return res.status(200).json({
          type: InteractionResponseType.MODAL,
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

    // MODAL SUBMIT
    if (interaction.type === InteractionType.MODAL_SUBMIT) {
      const customId = interaction.data.custom_id;
      const guildId = interaction.guild_id;
      const userId = interaction.member?.user?.id || interaction.user?.id;
      const fields = interaction.data.components;

      const getField = (id) => {
        for (const row of fields) {
          for (const c of row.components) {
            if (c.custom_id === id) return c.value;
          }
        }
        return null;
      };

      if (customId === 'modal_set_employee') {
        const userInput = getField('user_id') || '';
        const channelInput = getField('channel_id') || '';
        const match = userInput.match(/\d{17,20}/);
        if (!match) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: 'Not your log.', flags: 64 },
          });
        }

        const quantity = parseInt(getField('quantity'), 10);
        if (isNaN(quantity) || quantity < 1) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `Logged **${quantity}x ${item.name}**. Your weekly total is now **${newTotal}**.`,
            flags: 64,
          },
        });
      }
    }

    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Unhandled interaction.', flags: 64 },
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
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
      { type: 2, custom_id: 'admin_pay_all', label: 'Run Pay Check', style: 3, emoji: { name: '💰' } },
      { type: 2, custom_id: 'admin_refresh', label: 'Refresh', style: 2, emoji: { name: '🔄' } },
    ],
  }];

  return { embeds: [embed], components };
}
