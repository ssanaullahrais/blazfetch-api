import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

type Driver = 'sqlite' | 'postgres' | 'mysql' | 'mongodb';

const CHOICES: { driver: Driver; label: string; example: string }[] = [
  { driver: 'sqlite', label: 'SQLite   - no server needed, works out of the box (recommended to start)', example: '' },
  { driver: 'postgres', label: 'PostgreSQL', example: 'postgres://user:password@localhost:5432/blazfetch' },
  { driver: 'mysql', label: 'MySQL / MariaDB', example: 'mysql://user:password@localhost:3306/blazfetch' },
  { driver: 'mongodb', label: 'MongoDB', example: 'mongodb://localhost:27017/blazfetch' },
];

const root = process.cwd();
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

/** Sets KEY=value in an env file's text, replacing the existing line or appending one. */
function setEnvValue(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, () => line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nBlazfetch setup\n---------------');

  let driver = flag('driver') as Driver | undefined;
  if (!driver) {
    console.log('Which database do you want to use?\n');
    CHOICES.forEach((c, i) => console.log(`  ${i + 1}) ${c.label}`));
    const answer = (await rl.question('\nChoose 1-4 [1]: ')).trim() || '1';
    driver = CHOICES[Number(answer) - 1]?.driver;
    if (!driver) throw new Error(`Invalid choice "${answer}".`);
  }
  if (!CHOICES.some((c) => c.driver === driver)) throw new Error(`Unknown driver "${driver}".`);

  let url = flag('url') ?? '';
  let sqlitePath = flag('sqlite-path') ?? '';
  if (driver === 'sqlite') {
    if (!sqlitePath && !flag('driver')) {
      sqlitePath = (await rl.question('SQLite file path [./data/blazfetch.sqlite3]: ')).trim();
    }
  } else if (!url) {
    const example = CHOICES.find((c) => c.driver === driver)!.example;
    console.log(`\nThe database must already exist (setup creates the tables, not the database itself).`);
    url = (await rl.question(`Connection URL (e.g. ${example}): `)).trim();
    if (!url) throw new Error('A connection URL is required for this database.');
  }
  rl.close();

  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : fs.readFileSync(examplePath, 'utf-8');
  text = setEnvValue(text, 'DATABASE_DRIVER', driver);
  text = setEnvValue(text, 'DATABASE_URL', driver === 'sqlite' ? '' : url);
  if (sqlitePath) text = setEnvValue(text, 'DATABASE_SQLITE_PATH', sqlitePath);
  fs.writeFileSync(envPath, text);
  console.log(`\nSaved database settings to .env (DATABASE_DRIVER=${driver}).`);

  // Loaded only now so the app's config sees the .env we just wrote.
  const { getDb } = await import('../src/db');
  const db = getDb();
  if (!(await db.checkConnection())) {
    await db.close().catch(() => undefined);
    console.error('\nCould not connect to the database. Check the connection URL and that the server is running, then re-run: npm run setup');
    process.exit(1);
  }
  await db.migrate();
  await db.close();
  console.log('Connected and created the tables.\n\nDone. Start the server with: npm run dev   (check tools with: npm run diagnostics)');
}

main().catch((err) => {
  console.error(`\nSetup failed: ${(err as Error).message}`);
  process.exit(1);
});
