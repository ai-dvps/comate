// Sidecar entrypoint — this process always hosts the Comate sidecar API.

async function main(): Promise<void> {
  await import('./server-main.js');
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
