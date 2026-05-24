import { Command } from 'commander';
import path from 'path';
import { loadConfig } from './config/loader';
import { buildServer } from './server';

const program = new Command();

program
  .name('govproxy')
  .description('AI adoption intelligence platform for engineering teams')
  .version('0.1.0');

program
  .command('start')
  .description('Start the GovProxy server')
  .option('-c, --config <path>', 'Path to config file', 'govproxy.config.yaml')
  .action(async (options: { config: string }) => {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    const app = buildServer(config);
    await app.listen({ port: config.server.port, host: config.server.host });
  });

program.parse();
