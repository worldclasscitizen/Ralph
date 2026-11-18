import { createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, isAbsolute, relative } from "node:path";
import { validateCatalog, verifyCatalog } from "../dist/catalog.js";

const args = process.argv.slice(2);
const useStdin = args[0] === "--stdin";
if (useStdin) args.shift();
const catalogPath = resolve(args[0] ?? "assets/catalog-v2.json");
const signaturePath = resolve(args[1] ?? "assets/catalog-v2.sig");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
if (catalog.schemaVersion !== 2) throw new Error("Expected a v2 catalog.");
validateCatalog(catalog);

let privateKeyBytes;
if (useStdin) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  privateKeyBytes = Buffer.concat(chunks);
  if (!privateKeyBytes.length) throw new Error("The signing key was not provided.");
} else {
  const privateKeyPath = process.env.RALPH_CATALOG_PRIVATE_KEY;
  if (!privateKeyPath || !isAbsolute(privateKeyPath))
    throw new Error("RALPH_CATALOG_PRIVATE_KEY must name an absolute path outside the repository.");
  const relativeKey = relative(process.cwd(), resolve(privateKeyPath));
  if (!relativeKey.startsWith("..") && !isAbsolute(relativeKey))
    throw new Error("Signing key must stay outside the repository.");
  privateKeyBytes = await readFile(privateKeyPath);
}
const privateKey = createPrivateKey(privateKeyBytes);
privateKeyBytes.fill(0);
const signature = sign(null, Buffer.from(JSON.stringify(catalog)), privateKey).toString("base64");
if (!verifyCatalog(catalog, signature)) throw new Error("The signature does not match Ralph's current catalog public key.");
await writeFile(signaturePath, `${signature}\n`, { mode: 0o644 });
process.stdout.write(`서명을 작성했습니다: ${signaturePath}\n`);
