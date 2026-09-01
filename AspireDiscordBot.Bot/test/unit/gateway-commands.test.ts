import { ApplicationCommandOptionType, ApplicationCommandType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildDiscordCommands } from '../../src/discord/gateway.js';

describe('Discord command definitions', () => {
  it('registers slash and privacy-preserving message-context entry points', () => {
    const commands = buildDiscordCommands(2_000);
    const slash = commands.find((command) => command.name === 'ask');
    const message = commands.find((command) => command.name === 'Ask Aspirey');

    expect(message?.type).toBe(ApplicationCommandType.Message);
    expect(slash?.type).toBe(ApplicationCommandType.ChatInput);
    expect(slash?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          max_length: 2_000,
          name: 'question',
          type: ApplicationCommandOptionType.String,
        }),
        expect.objectContaining({
          name: 'image',
          type: ApplicationCommandOptionType.Attachment,
        }),
        expect.objectContaining({
          name: 'file',
          type: ApplicationCommandOptionType.Attachment,
        }),
      ]),
    );
  });
});
