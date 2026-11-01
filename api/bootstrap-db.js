
// Creates the pulsebank database inside the existing Render Postgres instance
// if it does not exist yet, so migrations can run into a clean schema.
// Uses PG_ADMIN_URL (same instance, "postgres" database). Safe to re-run.
const { Client } = require('pg');

async function main() {
  const adminUrl = process.env.PG_ADMIN_URL;
  if (!adminUrl) {
    console.error('PG_ADMIN_URL not set - cannot ensure pulsebank database');
    process.exit(1);
  }
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'pulsebank'");
    if (exists.rowCount === 0) {
      await admin.query('CREATE DATABASE pulsebank');
      console.log('Created database pulsebank');
    } else {
      console.log('Database pulsebank already exists');
    }
  } catch (err) {
    // 42P04 = duplicate database (race); anything else is fatal
    if (err.code === '42P04') {
      console.log('Database pulsebank already exists');
    } else {
      console.error('bootstrap-db failed:', err.message);
      process.exit(1);
    }
  } finally {
    try { await admin.end(); } catch (e) {}
  }
  process.exit(0);
}

main();
