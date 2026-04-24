import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

// Folders a stock Akai MPC card usually has at the root. Finding any one of
// these on a removable drive strongly suggests it's an MPC card.
// Also accept any folder name starting with "MPC" (MPC-Sample, MPC-One, etc.)
// via MPC_NAME_PATTERN below.
const MPC_SIGNATURE_DIRS = ['Expansions', 'Projects', 'Samples'];
const MPC_NAME_PATTERN = /^MPC(\b|[-_ ])/i;
// Name of the folder this app creates on the MPC card for its exports.
// Capitalized for visibility in the MPC browser alongside Akai's own folders.
const EXPORT_FOLDER_NAME = 'TERMINATOR';

export interface DriveCandidate {
  mountpoint: string;   // e.g. "E:\\" or "/Volumes/MPC"
  label: string;        // volume label if available
}

/** Enumerate removable drives using platform-native tooling. */
export async function listRemovableDrives(): Promise<DriveCandidate[]> {
  if (process.platform === 'win32') return listRemovableDrivesWindows();
  if (process.platform === 'darwin') return listRemovableDrivesMac();
  if (process.platform === 'linux') return listRemovableDrivesLinux();
  return [];
}

async function listRemovableDrivesWindows(): Promise<DriveCandidate[]> {
  // Get-Volume gives DriveType === 'Removable' for USB/SD. FileSystem is null
  // for unmounted volumes; DriveLetter is null for mounted-folder volumes.
  const script = `Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } | Select-Object DriveLetter,FileSystemLabel | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter(v => v && v.DriveLetter)
      .map(v => ({
        mountpoint: `${v.DriveLetter}:\\`,
        label: (v.FileSystemLabel ?? '').toString(),
      }));
  } catch {
    return [];
  }
}

async function listRemovableDrivesMac(): Promise<DriveCandidate[]> {
  // diskutil list -plist returns all disks; we filter to those mounted under
  // /Volumes and exclude the startup disk. For a minimal version we just
  // enumerate /Volumes entries and call any non-"Macintosh HD" removable.
  try {
    const entries = await fs.promises.readdir('/Volumes');
    return entries
      .filter(name => !name.startsWith('Macintosh HD'))
      .map(name => ({ mountpoint: `/Volumes/${name}`, label: name }));
  } catch {
    return [];
  }
}

async function listRemovableDrivesLinux(): Promise<DriveCandidate[]> {
  try {
    const { stdout } = await execFileAsync('lsblk', ['-J', '-o', 'MOUNTPOINT,LABEL,RM']);
    const parsed = JSON.parse(stdout);
    const out: DriveCandidate[] = [];
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        if (n.rm && n.mountpoint) out.push({ mountpoint: n.mountpoint, label: n.label ?? '' });
        if (n.children) walk(n.children);
      }
    };
    walk(parsed.blockdevices ?? []);
    return out;
  } catch {
    return [];
  }
}

/** Given a mountpoint, return the name of the MPC folder at its root (e.g.
 *  "MPC-Sample") if one exists, else null. */
async function findMpcFolderName(mountpoint: string): Promise<string | null> {
  try {
    const entries = await fs.promises.readdir(mountpoint, { withFileTypes: true });
    const match = entries.find(e => e.isDirectory() && MPC_NAME_PATTERN.test(e.name));
    return match?.name ?? null;
  } catch {
    return null;
  }
}

/** Inspect a mountpoint and return the preferred export directory (full path
 *  ending in `TERMINATOR`) if this looks like an MPC card, otherwise null.
 *
 *  Preference order:
 *    1. <mountpoint>/<MPC folder>/Samples/User/TERMINATOR  (matches Akai's
 *       user-samples convention — visible in the MPC browser)
 *    2. <mountpoint>/<MPC folder>/TERMINATOR
 *    3. <mountpoint>/TERMINATOR  (fallback — when only generic signature dirs
 *       like Projects/Expansions/Samples exist at the root)
 */
export async function resolveMpcExportDir(mountpoint: string): Promise<string | null> {
  const mpcFolder = await findMpcFolderName(mountpoint);
  if (mpcFolder) {
    const userSamples = path.join(mountpoint, mpcFolder, 'Samples', 'User');
    try {
      const s = await fs.promises.stat(userSamples);
      if (s.isDirectory()) return path.join(userSamples, EXPORT_FOLDER_NAME);
    } catch { /* no User samples folder — fall through */ }
    return path.join(mountpoint, mpcFolder, EXPORT_FOLDER_NAME);
  }
  // No MPC-named folder, but maybe a generic signature folder exists. Also
  // accept a pre-existing terminator folder (either case) as a signature.
  for (const dir of [...MPC_SIGNATURE_DIRS, EXPORT_FOLDER_NAME, 'terminator']) {
    try {
      const s = await fs.promises.stat(path.join(mountpoint, dir));
      if (s.isDirectory()) return path.join(mountpoint, EXPORT_FOLDER_NAME);
    } catch { /* try next */ }
  }
  return null;
}

/** Poll attached drives for an MPC card. Returns the full export directory
 *  path (or null if none detected). */
export async function findMpcExportDir(): Promise<string | null> {
  const drives = await listRemovableDrives();
  for (const d of drives) {
    const dir = await resolveMpcExportDir(d.mountpoint);
    if (dir) return dir;
  }
  return null;
}

/** Extract the mountpoint (drive root) from a full export path.
 *  Windows: "E:\MPC-Sample\Samples\User\terminator" → "E:"
 *  POSIX:   "/Volumes/MPC-Sample/Samples/User/terminator" → "/Volumes/MPC-Sample" */
function mountpointFromExportDir(exportDir: string): string {
  if (process.platform === 'win32') return exportDir.slice(0, 2); // "E:"
  // On macOS/Linux take the first two path segments (e.g. /Volumes/<name>)
  const parts = exportDir.split('/').filter(Boolean);
  return '/' + parts.slice(0, 2).join('/');
}

/** Safely eject the drive that hosts `exportDir`. On Windows this triggers
 *  the normal "Safely Remove Hardware" flow. The dismount is async, so we
 *  verify from Node by polling `listRemovableDrives` until the drive is gone
 *  (up to `timeoutMs`). This keeps PowerShell error formatting out of our
 *  user-facing error messages. */
export async function ejectDriveForExportDir(
  exportDir: string,
  timeoutMs = 8000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const mp = mountpointFromExportDir(exportDir);
  try {
    if (process.platform === 'win32') {
      const driveLetter = mp.slice(0, 2).toUpperCase();
      const letterLower = driveLetter.charAt(0).toLowerCase();
      const root = `${driveLetter}\\`; // "E:\"

      // Step 0: close any Explorer windows currently showing this drive.
      // Each one holds a file-system handle on the root, which blocks both
      // Shell.Application Eject and `mountvol /D`. Only File Explorer / IE
      // windows are enumerated here — other Electron/Chrome windows are
      // unaffected.
      const closeScript = `$sh = New-Object -ComObject Shell.Application; foreach ($w in $sh.Windows()) { try { $u = ($w.LocationURL).ToString(); if ($u -and $u.ToLower().StartsWith('file:///${letterLower}:')) { $w.Quit() } } catch {} }`;
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', closeScript]).catch(() => {});
      // Brief pause so Explorer's file-system watchers finish releasing
      // their handles before we ask Windows to dismount the volume.
      await sleep(250);

      // Step 1: Shell.Application Eject — the "Safely Remove Hardware" path.
      // Some SD-card drivers ignore IOCTL_STORAGE_EJECT_MEDIA, so this can be
      // a no-op; we check and fall back to mountvol below.
      const shellScript = `$sh = New-Object -ComObject Shell.Application; $i = $sh.Namespace(17).ParseName('${driveLetter}'); if ($i) { $i.InvokeVerb('Eject') }`;
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', shellScript]).catch(() => {});

      if (await waitForUnmount(root, timeoutMs / 2)) return { ok: true };

      // Step 2: mountvol /D — filesystem-level dismount. Doesn't power off
      // the device but removes the drive letter, which is usually what the
      // user actually wants. Works on readers that ignore IOCTL eject.
      const { err: mvErr } = await execFileAsync('mountvol', [driveLetter, '/D'])
        .then(() => ({ err: null }))
        .catch((e: any) => ({ err: e }));

      if (await waitForUnmount(root, timeoutMs / 2)) return { ok: true };

      const hint = mvErr
        ? `${mvErr.message?.trim() ?? 'mountvol refused'} — close any Explorer windows showing ${driveLetter} and retry`
        : `${driveLetter} still mounted — something has a file open on the card. Close any Explorer windows showing ${driveLetter} and retry.`;
      return { ok: false, error: hint };
    }

    if (process.platform === 'darwin') {
      await execFileAsync('diskutil', ['eject', mp]);
      return { ok: true };
    }

    // Linux best-effort
    await execFileAsync('udisksctl', ['unmount', '-b', mp]).catch(() => {});
    await execFileAsync('udisksctl', ['power-off', '-b', mp]).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: (e?.message ?? String(e)).toString().trim() };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Poll the drive root for `timeoutMs` ms; resolve true once it's unreadable
 *  (drive gone), false if we hit the timeout still accessible. */
async function waitForUnmount(root: string, timeoutMs: number): Promise<boolean> {
  // Give Windows a beat before the first probe — poking a drive mid-dismount
  // can itself keep a handle live and defeat the operation.
  await sleep(300);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.promises.access(root);
    } catch {
      return true;
    }
    await sleep(400);
  }
  return false;
}
