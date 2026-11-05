// Dedicated Linux reexec entry. No runner or SDK imports until evidence is validated.
import { pathToFileURL } from "node:url";
import { acceptBootstrap, linuxFailure } from "./linux.mjs";
try {
  if (process.platform !== "linux" || process.argv.length !== 3) throw linuxFailure("invalid bootstrap entry");
  const payload = JSON.parse(process.argv[2]);
  await acceptBootstrap(payload);
  process.argv = payload.argv;
  await import(pathToFileURL(process.argv[1]).href);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
