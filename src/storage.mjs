import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FORMAT = "ecoin-ledger-snapshot";
const VERSION = 1;

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function encodeSnapshot(ledger) {
  const payload=JSON.stringify(ledger);
  return JSON.stringify({ format:FORMAT, version:VERSION, savedAt:new Date().toISOString(), checksum:checksum(payload), ledger },null,2);
}

export function decodeSnapshot(text) {
  const parsed=JSON.parse(text);
  if (parsed?.format!==FORMAT) {
    if (parsed?.accounts && Array.isArray(parsed?.blocks)) return { ledger:parsed, legacy:true };
    throw new Error("Unknown ledger snapshot format");
  }
  if (parsed.version!==VERSION) throw new Error(`Unsupported ledger snapshot version ${parsed.version}`);
  if (checksum(JSON.stringify(parsed.ledger))!==parsed.checksum) throw new Error("Ledger snapshot checksum mismatch");
  return { ledger:parsed.ledger, legacy:false, savedAt:parsed.savedAt };
}

export async function loadSnapshot(primaryFile,backupFile,validate=()=>true) {
  const failures=[];
  let found=false;
  for (const [source,file] of [["primary",primaryFile],["backup",backupFile]]) {
    try {
      const decoded=decodeSnapshot(await readFile(file,"utf8"));
      found=true;
      if (!validate(decoded.ledger)) throw new Error("Ledger snapshot failed semantic verification");
      return { snapshot:decoded.ledger, source, legacy:decoded.legacy };
    } catch (error) {
      if (error.code==="ENOENT") continue;
      found=true; failures.push(`${source}: ${error.message}`);
    }
  }
  if (!found) return { snapshot:null,source:"new",legacy:false };
  throw new Error(`No valid ledger snapshot available (${failures.join("; ")})`);
}

export async function saveSnapshot(primaryFile,backupFile,ledger,{rotate=true}={}) {
  await mkdir(dirname(primaryFile),{recursive:true});
  const temporary=`${primaryFile}.tmp`;
  await writeFile(temporary,encodeSnapshot(ledger),"utf8");
  if (rotate) {
    try {
      decodeSnapshot(await readFile(primaryFile,"utf8"));
      await copyFile(primaryFile,backupFile);
    } catch (error) {
      if (error.code!=="ENOENT" && !/snapshot|JSON|format|version|checksum/i.test(error.message)) throw error;
    }
  }
  await rename(temporary,primaryFile);
}
