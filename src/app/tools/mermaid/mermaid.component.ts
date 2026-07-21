import { Component, OnDestroy, signal, computed, inject, effect, untracked } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { TopbarComponent } from '../../layout/topbar/topbar.component';
import { IconComponent } from '../../core/icon.component';
import { CodeEditorComponent } from '../../core/components/code-editor/code-editor.component';
import { SettingsService } from '../../core/services/settings.service';
import mermaid from 'mermaid';

const FLOWCHART = `flowchart TD
    A[Start] --> B{Is it working?}
    B -->|Yes| C[Deploy]
    B -->|No| D[Debug]
    D --> B
    C --> E[Monitor]
    E --> F(Done)`;

const SEQUENCE = `sequenceDiagram
    participant U as User
    participant F as Frontend
    participant B as Backend
    participant D as Database
    U->>F: Click login
    F->>B: POST /auth
    B->>D: Query user
    D-->>B: User record
    B-->>F: JWT token
    F-->>U: Redirect to dashboard`;

const CLASS = `classDiagram
    class Animal {
        +String name
        +int age
        +makeSound() void
    }
    class Dog {
        +fetch() void
    }
    class Cat {
        +purr() void
    }
    Animal <|-- Dog
    Animal <|-- Cat`;

const ER = `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    CUSTOMER {
        int id PK
        string name
        string email
    }
    ORDER {
        int id PK
        date created_at
        string status
    }
    LINE-ITEM {
        int id PK
        int quantity
        float price
    }`;

const GANTT = `gantt
    title Project Roadmap
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d
    section Planning
    Requirements     :done,    req, 2025-01-01, 2025-01-10
    Design           :active,  des, 2025-01-11, 2025-01-20
    section Development
    Backend          :         be,  2025-01-21, 2025-02-10
    Frontend         :         fe,  2025-01-28, 2025-02-15
    section QA
    Testing          :         test, 2025-02-16, 2025-02-25
    Release          :         rel, 2025-02-26, 2025-03-01`;

const SAMPLES: Record<string, { label: string; src: string }> = {
  flowchart: { label: 'Flowchart', src: FLOWCHART },
  sequence: { label: 'Sequence', src: SEQUENCE },
  class: { label: 'Class', src: CLASS },
  er: { label: 'ER Diagram', src: ER },
  gantt: { label: 'Gantt', src: GANTT },
};

const SAMPLE_KEYS = Object.keys(SAMPLES);

@Component({
  selector: 'dt-tool-mermaid',
  imports: [TopbarComponent, IconComponent, CodeEditorComponent],
  styles: [`
    :host { display:flex; flex-direction:column; flex:1; min-height:0; }
    .error-banner {
      font-size:12px; color:#e05252; background:rgba(224,82,82,.08);
      border:1px solid rgba(224,82,82,.18); border-radius:8px; padding:8px 12px;
      margin:8px 12px; flex-shrink:0;
    }
    .mmd-preview :deep(svg) { max-width:100%; height:auto; }
  `],
  template: `
    <div style="flex:1;display:flex;flex-direction:column;min-height:0;background:var(--bg);font-family:var(--font-ui)">
      <dt-topbar [crumbs]="['Text & Code', 'Mermaid Editor']" [toolId]="'mermaid'" />

      <div style="display:flex;align-items:center;gap:10px;padding:10px 18px 8px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap">
        <div style="width:32px;height:32px;border-radius:8px;background:var(--maroon-soft);display:grid;place-items:center;flex-shrink:0">
          <dt-icon name="share" [size]="16" [color]="'var(--maroon)'" />
        </div>
        <div>
          <div style="font-size:15.5px;font-weight:600;letter-spacing:-0.2px;color:var(--text)">Mermaid Editor</div>
          <div style="font-size:12px;color:var(--text-muted)">Live Mermaid diagram editor</div>
        </div>
        <div style="flex:1"></div>

        @for (sample of sampleIds; track sample) {
          <button (click)="loadSample(sample)"
            style="background:transparent;color:var(--text);border:1px solid var(--border);height:28px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:500;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            {{ SAMPLES[sample].label }}
          </button>
        }

        <label style="cursor:pointer;margin:0">
          <input type="file" accept=".mmd,.md,.mermaid,text/plain" style="display:none" (change)="onFileInput($event)" />
          <span style="font-size:12.5px;font-weight:500;color:var(--text);border:1px solid var(--border);border-radius:7px;height:28px;padding:0 12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;box-sizing:border-box">
            Open
          </span>
        </label>

        <button (click)="copySource()" style="background:var(--teal);color:#fff;height:28px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:500;display:inline-flex;align-items:center;gap:6px;cursor:pointer;border:none">
          <dt-icon name="copy" [size]="13" [color]="'#fff'" />
          {{ copiedSrc() ? 'Copied!' : 'Copy Source' }}
        </button>

        <button (click)="copySvg()" [disabled]="!svgString()"
          [style.opacity]="svgString() ? '1' : '0.45'"
          style="background:transparent;color:var(--text);border:1px solid var(--border);height:28px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:500;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
          <dt-icon name="copy" [size]="13" />
          {{ copiedSvg() ? 'Copied SVG!' : 'Copy SVG' }}
        </button>

        <button (click)="exportSvg()" [disabled]="!svgString()"
          [style.opacity]="svgString() ? '1' : '0.45'"
          style="background:transparent;color:var(--text);border:1px solid var(--border);height:28px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:500;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
          <dt-icon name="download" [size]="13" />
          Export SVG
        </button>

        <button (click)="exportPng()" [disabled]="!svgString()"
          [style.opacity]="svgString() ? '1' : '0.45'"
          style="background:transparent;color:var(--text);border:1px solid var(--border);height:28px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:500;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
          <dt-icon name="download" [size]="13" />
          Export PNG
        </button>
      </div>

      <div style="flex:1;min-height:0;display:flex;overflow:hidden">
        <div style="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--border)">
          <div style="height:34px;padding:0 14px;display:flex;align-items:center;background:var(--surface-muted);border-bottom:1px solid var(--border);flex-shrink:0">
            <span style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px">MERMAID</span>
          </div>
          <dt-code-editor language="plaintext" style="flex:1;min-height:0" [value]="inputVal()" (valueChange)="onInput($event)" />
          <div style="height:28px;padding:0 14px;display:flex;align-items:center;background:var(--surface-muted);border-top:1px solid var(--border);flex-shrink:0;gap:6px">
            @if (inputVal().trim()) {
              <span style="font-size:11.5px;color:var(--text-faint)">{{ inputVal().split('\n').length }} lines</span>
            }
            @if (renderStatus()) {
              <span style="font-size:11.5px;color:var(--text-faint);margin-left:auto">{{ renderStatus() }}</span>
            }
          </div>
        </div>

        <div style="flex:1;display:flex;flex-direction:column;min-width:0">
          <div style="height:34px;padding:0 14px;display:flex;align-items:center;background:var(--surface-muted);border-bottom:1px solid var(--border);flex-shrink:0">
            <span style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px">PREVIEW</span>
          </div>
          @if (errorMsg()) {
            <div class="error-banner">{{ errorMsg() }}</div>
          }
          <div
            class="mmd-preview"
            style="flex:1;overflow:auto;padding:20px 28px;background:var(--surface);display:flex;align-items:flex-start;justify-content:center"
            [innerHTML]="safeSvg()">
          </div>
          <div style="height:28px;padding:0 14px;display:flex;align-items:center;background:var(--surface-muted);border-top:1px solid var(--border);flex-shrink:0">
            <span style="font-size:11.5px;color:var(--text-faint)">
              @if (errorMsg()) { Render error } @else if (svgString()) { Live preview } @else { Enter Mermaid source to preview }
            </span>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class MermaidComponent implements OnDestroy {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly settings = inject(SettingsService);

  readonly SAMPLES = SAMPLES;
  readonly sampleIds = SAMPLE_KEYS;

  readonly inputVal = signal('');
  readonly svgString = signal('');
  readonly errorMsg = signal('');
  readonly copiedSrc = signal(false);
  readonly copiedSvg = signal(false);
  readonly renderStatus = signal('');

  private renderSeq = 0;
  private initDone = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private renderGeneration = 0;

  readonly safeSvg = computed(() => {
    const svg = this.svgString();
    return svg ? this.sanitizer.bypassSecurityTrustHtml(svg) : null;
  });

  constructor() {
    // Re-init Mermaid theme when the app light/dark theme changes.
    // Do not track inputVal here — typing is handled by the debounced onInput path.
    effect(() => {
      this.settings.effectiveTheme();
      untracked(() => {
        this.initDone = false;
        const src = this.inputVal();
        if (src.trim()) void this.renderMermaid(src);
      });
    });
  }

  ngOnDestroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  onInput(value: string): void {
    this.inputVal.set(value);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.renderMermaid(value), 250);
  }

  loadSample(key: string): void {
    const sample = SAMPLES[key];
    if (!sample) return;
    this.inputVal.set(sample.src);
    this.renderMermaid(sample.src);
  }

  async renderMermaid(source: string): Promise<void> {
    const generation = ++this.renderGeneration;

    if (!source.trim()) {
      this.svgString.set('');
      this.errorMsg.set('');
      this.renderStatus.set('');
      return;
    }

    try {
      await this.ensureInit();
      const id = `mmd-${++this.renderSeq}`;
      const { svg } = await mermaid.render(id, source);
      if (generation !== this.renderGeneration) return;
      this.svgString.set(svg);
      this.errorMsg.set('');
      this.renderStatus.set('Rendered OK');
    } catch (err: any) {
      if (generation !== this.renderGeneration) return;
      this.svgString.set('');
      this.errorMsg.set(err?.message ?? String(err));
      this.renderStatus.set('Parse error');
    }
  }

  private async ensureInit(): Promise<void> {
    if (!this.initDone) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: this.settings.effectiveTheme() === 'dark' ? 'dark' : 'default',
      });
      this.initDone = true;
    }
  }

  async copySource(): Promise<void> {
    await navigator.clipboard.writeText(this.inputVal());
    this.copiedSrc.set(true);
    setTimeout(() => this.copiedSrc.set(false), 1500);
  }

  async copySvg(): Promise<void> {
    const svg = this.svgString();
    if (!svg) return;
    await navigator.clipboard.writeText(svg);
    this.copiedSvg.set(true);
    setTimeout(() => this.copiedSvg.set(false), 1500);
  }

  exportSvg(): void {
    const svg = this.svgString();
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.svg';
    a.click();
    URL.revokeObjectURL(url);
  }

  exportPng(): void {
    const svg = this.svgString();
    if (!svg) return;

    const dims = this.readSvgDimensions(svg);
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || dims.width;
      canvas.height = img.naturalHeight || dims.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); return; }
      ctx.fillStyle = this.settings.effectiveTheme() === 'dark' ? '#1c1a17' : '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => {
        if (!blob) return;
        const pngUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = 'diagram.png';
        a.click();
        URL.revokeObjectURL(pngUrl);
      }, 'image/png');
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      this.errorMsg.set('Could not render diagram to PNG.');
    };

    img.src = url;
  }

  private readSvgDimensions(svg: string): { width: number; height: number } {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    if (root?.tagName?.toLowerCase() !== 'svg') return { width: 800, height: 600 };

    const width = this.parseSvgLength(root.getAttribute('width'));
    const height = this.parseSvgLength(root.getAttribute('height'));
    if (width && height) return { width, height };

    const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
      return { width: Math.round(viewBox[2]), height: Math.round(viewBox[3]) };
    }

    return { width: 800, height: 600 };
  }

  private parseSvgLength(value: string | null): number | null {
    if (!value) return null;
    const match = value.trim().match(/^(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
  }

  onFileInput(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      this.inputVal.set(text);
      this.renderMermaid(text);
    };
    reader.readAsText(file);
    (event.target as HTMLInputElement).value = '';
  }
}
