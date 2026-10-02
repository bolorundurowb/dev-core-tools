import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { TopbarComponent } from '../../layout/topbar/topbar.component';
import { IconComponent } from '../../core/icon.component';

export interface FileItem {
  id: number;
  file: File;
  nativePath?: string;
  status: 'pending' | 'converting' | 'done' | 'error';
  outputBlob?: Blob;
  outputSize?: number;
  errorMsg?: string;
}

const MIME_MAP: Record<string, string> = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  WebP: 'image/webp',
  AVIF: 'image/avif',
  ICO: 'image/x-icon',
};

const EXT_MAP: Record<string, string> = {
  PNG: 'png', JPG: 'jpg', WebP: 'webp', AVIF: 'avif', ICO: 'ico',
};

const NATIVE_IMAGE_THRESHOLD_BYTES = 2 * 1024 * 1024;

interface NativeImageResult {
  output_path: string;
}

let nextId = 0;

/**
 * Encapsulates raw PNG data into a standard Windows ICO (.ico) file container.
 * The modern ICO format natively supports embedded PNG frames (Vista+).
 */
export function createIcoFromPng(pngBytes: Uint8Array, width: number, height: number): Uint8Array {
  const totalSize = 6 + 16 + pngBytes.length;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  // 1. ICONDIR Header (6 bytes)
  view.setUint16(0, 0, true);       // Reserved (must be 0)
  view.setUint16(2, 1, true);       // Resource type: 1 = ICO
  view.setUint16(4, 1, true);       // Image count: 1

  // 2. ICONDIRENTRY (16 bytes)
  // Width and height: 1-255; 0 represents 256 pixels
  const w = width >= 256 ? 0 : width;
  const h = height >= 256 ? 0 : height;

  view.setUint8(6, w);              // Width
  view.setUint8(7, h);              // Height
  view.setUint8(8, 0);              // Color count (0 = no palette)
  view.setUint8(9, 0);              // Reserved
  view.setUint16(10, 1, true);      // Color planes: 1
  view.setUint16(12, 32, true);     // Bits per pixel: 32 (RGBA)
  view.setUint32(14, pngBytes.length, true); // Image data size in bytes
  view.setUint32(18, 22, true);     // Offset of image data from beginning (6 + 16 = 22)

  // 3. PNG Image Data
  out.set(pngBytes, 22);

  return out;
}

@Component({
    selector: 'dt-tool-img-converter',
    imports: [FormsModule, TopbarComponent, IconComponent],
    styles: [`:host{display:flex;flex-direction:column;flex:1;min-height:0}`],
    template: `
<div style="flex:1;display:flex;flex-direction:column;min-height:0;background:var(--bg)">
  <dt-topbar [crumbs]="['Images', 'Image Converter']" [toolId]="'img-convert'" />

  <!-- Header bar -->
  <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border);flex-shrink:0">
    <div style="width:32px;height:32px;border-radius:8px;background:var(--maroon-soft);display:grid;place-items:center">
      <dt-icon name="image" [size]="16" color="var(--maroon)" />
    </div>
    <div>
      <div style="font-size:15px;font-weight:600">Image Converter</div>
      <div style="font-size:12px;color:var(--text-muted)">Convert PNG, JPG, WebP, AVIF, ICO with native fallback for large files</div>
    </div>
    <div style="flex:1"></div>
    <button (click)="convertAll()" [disabled]="pendingCount() === 0"
      style="background:var(--maroon);color:#fff;height:28px;padding:0 14px;border-radius:7px;font-size:12.5px;font-weight:500;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;opacity:1"
      [style.opacity]="pendingCount() === 0 ? '0.45' : '1'">
      <dt-icon name="layers" [size]="12" color="#fff" /> Convert all
    </button>
  </div>

  <!-- Two-column layout -->
  <div style="flex:1;min-height:0;display:flex;overflow:hidden">

    <!-- Left: drop zone + queue -->
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden">
      <!-- Drop zone -->
      <div
        (dragover)="$event.preventDefault(); dragOver.set(true)"
        (dragleave)="dragOver.set(false)"
        (drop)="onDrop($event)"
        (click)="selectFiles(fileInput)"
        [style.background]="dragOver() ? 'var(--maroon-soft)' : 'var(--surface)'"
        [style.border-color]="dragOver() ? 'var(--maroon)' : 'var(--border)'"
        style="margin:16px;border:2px dashed var(--border);border-radius:10px;padding:24px;display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;flex-shrink:0;transition:background .15s,border-color .15s">
        <dt-icon name="upload" [size]="24" color="var(--text-muted)" />
        <div style="font-size:13px;font-weight:500;color:var(--text)">Drop images here</div>
        <div style="font-size:11.5px;color:var(--text-muted)">or click to browse — PNG, JPG, WebP, AVIF, ICO</div>
        <input #fileInput type="file" multiple accept="image/*" style="display:none" (change)="onFileInput($event)" />
      </div>

      <!-- File queue -->
      <div style="flex:1;min-height:0;overflow-y:auto;padding:0 16px 16px">
        @if (files().length === 0) {
          <div style="text-align:center;padding:32px 0;font-size:13px;color:var(--text-faint)">No files added yet</div>
        }
        @for (item of files(); track item.id) {
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:6px;background:var(--surface-muted);display:grid;place-items:center;flex-shrink:0">
              <dt-icon name="image" [size]="16" color="var(--text-muted)" />
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ item.file.name }}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
                {{ sourceFormat(item) }} → {{ targetFormat() }}
                &nbsp;·&nbsp;
                {{ formatSize(item.file.size) }}
                @if (item.status === 'done' && item.outputSize) {
                  → {{ formatSize(item.outputSize) }}
                  <span [style.color]="item.outputSize < item.file.size ? 'var(--teal)' : 'var(--text-muted)'">
                    ({{ sizeDelta(item) }})
                  </span>
                }
              </div>
            </div>
            <!-- Status badge -->
            <div style="flex-shrink:0">
              @if (item.status === 'pending') {
                <span style="font-size:11px;color:var(--text-faint);background:var(--surface-muted);padding:2px 8px;border-radius:10px">Pending</span>
              } @else if (item.status === 'converting') {
                <span style="font-size:11px;color:var(--teal);background:var(--teal-soft);padding:2px 8px;border-radius:10px">Converting…</span>
              } @else if (item.status === 'done') {
                <button (click)="downloadFile(item)" style="font-size:11px;color:var(--teal-ink);background:var(--teal-soft);padding:2px 8px;border-radius:10px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:4px">
                  <dt-icon name="download" [size]="11" color="var(--teal)" /> Download
                </button>
              } @else if (item.status === 'error') {
                <span style="font-size:11px;color:#e05;background:#ffe0ea;padding:2px 8px;border-radius:10px" [title]="item.errorMsg">Error</span>
              }
            </div>
            <button (click)="removeFile(item.id)" style="background:transparent;border:none;cursor:pointer;color:var(--text-faint);padding:4px;border-radius:4px;display:grid;place-items:center">
              <dt-icon name="trash" [size]="14" color="var(--text-faint)" />
            </button>
          </div>
        }
      </div>
    </div>

    <!-- Right: options panel -->
    <div style="width:260px;flex-shrink:0;overflow-y:auto;padding:16px">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Output Format</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:18px">
        @for (fmt of formats; track fmt) {
          <button (click)="targetFormat.set(fmt)"
            [style.background]="targetFormat() === fmt ? 'var(--maroon)' : 'var(--surface)'"
            [style.color]="targetFormat() === fmt ? '#fff' : 'var(--text)'"
            [style.border-color]="targetFormat() === fmt ? 'var(--maroon)' : 'var(--border)'"
            style="padding:8px;border-radius:7px;border:1px solid;font-size:13px;font-weight:600;cursor:pointer">
            {{ fmt }}
          </button>
        }
      </div>

      @if (targetFormat() !== 'PNG') {
        <div style="margin-bottom:18px">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">
            Quality: {{ quality() }}%
          </div>
          <input type="range" min="1" max="100" [value]="quality()" (input)="quality.set(+$any($event.target).value)"
            style="width:100%;accent-color:var(--maroon)" />
          <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-faint);margin-top:2px">
            <span>1%</span><span>100%</span>
          </div>
        </div>
      }

      <div style="margin-bottom:18px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Resize (optional)</div>
        <div style="display:flex;gap:6px;align-items:center">
          <div style="flex:1">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">Width</div>
            <input type="number" placeholder="auto" [(ngModel)]="resizeWidth" (ngModelChange)="onWidthChange()"
              style="width:100%;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box" />
          </div>
          <button (click)="lockAspect.set(!lockAspect())"
            [title]="lockAspect() ? 'Aspect locked' : 'Aspect unlocked'"
            style="background:transparent;border:1px solid var(--border);border-radius:6px;padding:5px;cursor:pointer;margin-top:14px;display:grid;place-items:center"
            [style.border-color]="lockAspect() ? 'var(--maroon)' : 'var(--border)'">
            <dt-icon name="lock" [size]="12" [color]="lockAspect() ? 'var(--maroon)' : 'var(--text-muted)'" />
          </button>
          <div style="flex:1">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">Height</div>
            <input type="number" placeholder="auto" [(ngModel)]="resizeHeight"
              style="width:100%;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box" />
          </div>
        </div>
      </div>

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px">Queue Summary</div>
        <div style="font-size:12px;color:var(--text);display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-muted)">Total</span>
            <span>{{ files().length }}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--text-muted)">Pending</span>
            <span>{{ pendingCount() }}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--teal)">Done</span>
            <span>{{ doneCount() }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
`
})
export class ImgConverterComponent {
  files = signal<FileItem[]>([]);
  dragOver = signal(false);
  targetFormat = signal<string>('WebP');
  quality = signal(85);
  lockAspect = signal(true);
  resizeWidth: number | null = null;
  resizeHeight: number | null = null;

  formats = ['PNG', 'JPG', 'WebP', 'AVIF', 'ICO'];

  pendingCount() { return this.files().filter(f => f.status === 'pending').length; }
  doneCount() { return this.files().filter(f => f.status === 'done').length; }

  sourceFormat(item: FileItem): string {
    const t = item.file.type;
    if (t.includes('png')) return 'PNG';
    if (t.includes('jpeg') || t.includes('jpg')) return 'JPG';
    if (t.includes('webp')) return 'WebP';
    if (t.includes('avif')) return 'AVIF';
    if (t.includes('icon') || item.file.name.toLowerCase().endsWith('.ico')) return 'ICO';
    return t.split('/')[1]?.toUpperCase() || '?';
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  sizeDelta(item: FileItem): string {
    if (!item.outputSize) return '';
    const pct = ((item.outputSize - item.file.size) / item.file.size * 100);
    return (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
  }

  async selectFiles(fileInput: HTMLInputElement) {
    try {
      const selected = await open({
        multiple: true,
        filters: [{
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'ico', 'bmp', 'svg'],
        }],
      });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        if (paths.length > 0) {
          await this.addPaths(paths);
          return;
        }
      }
    } catch {
      // Browser-only mode fallback or dialog error
    }
    fileInput.click();
  }

  async addPaths(paths: string[]) {
    const newItems: FileItem[] = [];
    for (const path of paths) {
      try {
        const bytes = await readFile(path);
        const name = path.replace(/^.*[\\\/]/, '');
        const ext = name.split('.').pop()?.toUpperCase() ?? '';
        const mime = MIME_MAP[ext] || (ext === 'JPEG' ? 'image/jpeg' : 'image/png');
        const file = new File([bytes.buffer as ArrayBuffer], name, { type: mime });
        newItems.push({
          id: nextId++,
          file,
          nativePath: path,
          status: 'pending',
        });
      } catch (err) {
        console.error('Failed to read file from path:', path, err);
      }
    }
    if (newItems.length > 0) {
      this.files.update(existing => [...existing, ...newItems]);
    }
  }

  onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragOver.set(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
    this.addFiles(files);
  }

  onFileInput(e: Event) {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    this.addFiles(files);
    (e.target as HTMLInputElement).value = '';
  }

  addFiles(files: File[]) {
    this.files.update(existing => [
      ...existing,
      ...files.map(f => ({ id: nextId++, file: f, status: 'pending' as const })),
    ]);
  }

  removeFile(id: number) {
    this.files.update(fs => fs.filter(f => f.id !== id));
  }

  onWidthChange() {
    // aspect lock handled at convert time
  }

  private nativePathFor(file: File): string | null {
    const path = (file as File & { path?: unknown }).path;
    return typeof path === 'string' && path.length > 0 ? path : null;
  }

  private async convertImageNative(item: FileItem, targetFmt: string, q: number): Promise<Blob | null> {
    const inputPath = item.nativePath || this.nativePathFor(item.file);
    const shouldUseNative = targetFmt === 'ICO'
      || item.file.size >= NATIVE_IMAGE_THRESHOLD_BYTES
      || !!this.resizeWidth
      || !!this.resizeHeight;
    if (!inputPath || !shouldUseNative) return null;

    const result = await invoke<NativeImageResult>('convert_image', {
      options: {
        input_path: inputPath,
        output_dir: await tempDir(),
        format: targetFmt,
        quality: q,
        resize_width: this.resizeWidth,
        resize_height: this.resizeHeight,
        keep_aspect: this.lockAspect(),
        strip_metadata: true,
      },
    });
    const bytes = await readFile(result.output_path);
    return new Blob([bytes.buffer as ArrayBuffer], { type: MIME_MAP[targetFmt] });
  }

  private async convertImageToIco(file: File): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = async () => {
        URL.revokeObjectURL(url);
        try {
          const origW = img.naturalWidth || img.width;
          const origH = img.naturalHeight || img.height;

          let targetW = this.resizeWidth || origW;
          let targetH = this.resizeHeight || origH;

          if (this.lockAspect() && this.resizeWidth && !this.resizeHeight) {
            targetH = Math.round(origH * (this.resizeWidth / origW));
          } else if (this.lockAspect() && this.resizeHeight && !this.resizeWidth) {
            targetW = Math.round(origW * (this.resizeHeight / origH));
          }

          // ICO dimensions must fit within 256x256
          if (targetW > 256 || targetH > 256) {
            const scale = Math.min(256 / targetW, 256 / targetH);
            targetW = Math.max(1, Math.round(targetW * scale));
            targetH = Math.max(1, Math.round(targetH * scale));
          }

          const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
          const noResize = !this.resizeWidth && !this.resizeHeight;
          if (isPng && noResize && origW <= 256 && origH <= 256) {
            const arrayBuf = await file.arrayBuffer();
            const icoBytes = createIcoFromPng(new Uint8Array(arrayBuf), origW, origH);
            resolve(new Blob([icoBytes.buffer as ArrayBuffer], { type: 'image/x-icon' }));
            return;
          }

          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Failed to create canvas 2d context for ICO'));
            return;
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, targetW, targetH);

          canvas.toBlob(async (blob) => {
            if (!blob) {
              reject(new Error('Failed to encode image to PNG for ICO container'));
              return;
            }
            try {
              const arrayBuf = await blob.arrayBuffer();
              const icoBytes = createIcoFromPng(new Uint8Array(arrayBuf), targetW, targetH);
              resolve(new Blob([icoBytes.buffer as ArrayBuffer], { type: 'image/x-icon' }));
            } catch (e) {
              reject(e);
            }
          }, 'image/png');
        } catch (err) {
          reject(err);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image for ICO conversion'));
      };

      img.src = url;
    });
  }

  async convertImage(item: FileItem, targetFmt: string, q: number): Promise<Blob> {
    try {
      const nativeBlob = await this.convertImageNative(item, targetFmt, q);
      if (nativeBlob) return nativeBlob;
    } catch {
      // Browser conversion keeps the tool usable outside Tauri and if native fails.
    }

    if (targetFmt === 'ICO') {
      return this.convertImageToIco(item.file);
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(item.file);
      img.onload = () => {
        let w = this.resizeWidth || img.width;
        let h = this.resizeHeight || img.height;
        if (this.lockAspect() && this.resizeWidth && !this.resizeHeight) {
          h = Math.round(img.height * (this.resizeWidth / img.width));
        } else if (this.lockAspect() && this.resizeHeight && !this.resizeWidth) {
          w = Math.round(img.width * (this.resizeHeight / img.height));
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob(
          blob => blob ? resolve(blob) : reject(new Error('Conversion failed')),
          MIME_MAP[targetFmt],
          q / 100,
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Load failed')); };
      img.src = url;
    });
  }

  convertAll() {
    const pending = this.files().filter(f => f.status === 'pending');
    const fmt = this.targetFormat();
    const q = this.quality();
    pending.forEach(item => {
      this.files.update(fs => fs.map(f => f.id === item.id ? { ...f, status: 'converting' } : f));
      this.convertImage(item, fmt, q)
        .then(blob => {
          this.files.update(fs => fs.map(f =>
            f.id === item.id ? { ...f, status: 'done', outputBlob: blob, outputSize: blob.size } : f,
          ));
        })
        .catch(err => {
          this.files.update(fs => fs.map(f =>
            f.id === item.id ? { ...f, status: 'error', errorMsg: (err?.message || String(err)) } : f,
          ));
        });
    });
  }

  downloadFile(item: FileItem) {
    if (!item.outputBlob) return;
    const ext = EXT_MAP[this.targetFormat()] ?? 'bin';
    const baseName = item.file.name.replace(/\.[^.]+$/, '');
    const url = URL.createObjectURL(item.outputBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
}
