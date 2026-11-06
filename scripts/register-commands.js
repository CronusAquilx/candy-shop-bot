import { REST, Routes } from 'discord.js';
import 'dotenv/config';

const commands = [
  {
    name: 'setup',
    description: 'Set up the Candy Shop bot',
    options: [
      {
        name: 'admin-panel',
        description: 'Post the Admin Panel',
        type: 1,
      },
      {
        name: 'logs-channel',
        description: 'Set the Logs channel',
        type: 1,
        options: [
          {
            name: 'channel',
            description: 'The channel to use for logs',
            type: 7,
            required: true,
            channel_types: [0],
          },
        ],
      },
      {
        name: 'employee',
        description: 'Link an employee to their sales channel and send them the logging panel',
        type: 1,
        options: [
          { name: 'user', description: 'The employee', type: 6, required: true },
          { name: 'channel', description: 'Their sales channel', type: 7, required: true, channel_types: [0] },
        ],
      },
      {
        name: 'admin-roles',
        description: 'Set which roles can use admin features',
        type: 1,
        options: [
          { name: 'role1', description: 'Admin role', type: 8, required: true },
          { name: 'role2', description: 'Additional role', type: 8, required: false },
          { name: 'role3', description: 'Additional role', type: 8, required: false },
        ],
      },
    ],
  },
  {
    name: 'items',
    description: 'Manage craftable items',
    options: [
      {
        name: 'add',
        description: 'Add a craftable item',
        type: 1,
        options: [
          { name: 'name', description: 'Item name', type: 3, required: true },
          { name: 'emoji', description: 'Emoji', type: 3, required: false },
        ],
      },
      {
        name: 'list',
        description: 'List all items',
        type: 1,
      },
      {
        name: 'remove',
        description: 'Deactivate an item',
        type: 1,
        options: [
          { name: 'name', description: 'Item name', type: 3, required: true },
        ],
      },
    ],
  },
];

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.warn('Skipping command registration: DISCORD_TOKEN or DISCORD_CLIENT_ID missing.');
  process.exit(0);
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  console.log('Registering commands...');
  const res = await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log(`Registered ${res.length} global commands: ${res.map(c => '/' + c.name).join(', ')}`);
} catch (err) {
  // Never fail the deploy because of registration
  console.error('Command registration failed:', err?.message || err);
}
process.exit(0);
