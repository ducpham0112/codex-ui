import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { QuotaProtectionService } from './quota-protection.service';

@Component({
  selector: 'codex-quota-protection', standalone: true, imports: [FormsModule],
  template: `
    @if(settings()) {
      <section class="settings-section">
        <h2>Quota protection</h2>
        <p>Pause sessions started here when the 5-hour quota reaches your reserve. Continue automatically once quota rises above it, even with this browser closed. External CLI sessions are unaffected.</p>
        <label class="setting-row"><span><b>5-hour quota reserve (%)</b><small>Default: 30%. Changes apply to all sessions started here.</small></span>
          <input type="number" min="1" max="99" step="1" aria-label="5-hour quota reserve (%)" [ngModel]="draft() ?? protection.status()?.reservePercent ?? 30" (ngModelChange)="draft.set($event);saved.set(false)" [disabled]="!protection.status() || protection.saving()">
        </label>
        <div class="actions"><small>Checked every 30 seconds and on quota updates. Remaining: {{protection.status()?.remainingPercent == null ? 'unavailable' : protection.status()!.remainingPercent + '%'}}</small><button type="button" (click)="save()" [disabled]="!valid() || !protection.status() || protection.saving()" aria-label="Save quota reserve">{{protection.saving() ? 'Saving…' : 'Save'}}</button></div>
        @if(saved()){<p role="status">Quota reserve saved.</p>}
        @if(protection.status()?.error){<p role="status">{{protection.status()!.error}}</p>}
        @for(work of protection.status()?.paused ?? []; track work.threadId) {
          <div class="paused"><div><b>Waiting for quota</b><small>Session {{work.threadId}} · {{work.state === 'starting' ? 'Confirming turn start…' : work.state === 'interrupting' ? 'Stopping current turn…' : 'Will continue automatically'}}</small></div><button type="button" (click)="protection.cancel(work.threadId)" [disabled]="protection.saving()">Cancel auto-continue</button></div>
        }
        @if(protection.error()){<p role="alert">{{protection.error()}}</p>}
      </section>
    } @else if(selectedPaused()) {
      <div class="paused" role="status"><div><b>{{selectedPaused()?.state === 'starting' ? 'Confirming session start' : 'Paused to preserve quota'}}</b><small>{{selectedPaused()?.state === 'starting' ? 'Waiting for the server to confirm this turn. Check Settings for details.' : 'Will continue automatically when the 5-hour quota exceeds ' + protection.status()?.reservePercent + '%.'}}</small></div><button type="button" (click)="protection.cancel(threadId())" [disabled]="protection.saving()">Cancel auto-continue</button></div>
      @if(protection.error()){<p role="alert">{{protection.error()}}</p>}
    }
  `,
  styles: [`
    :host{display:contents}p,small{color:var(--muted);font-size:12px;line-height:1.6}p{margin:10px 0}small{display:block}input{width:80px;padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:inherit;font:inherit}button{padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface2);color:inherit;font:inherit;font-size:12px;min-height:38px}button:disabled{opacity:.5;cursor:default}.actions,.paused{display:flex;align-items:center;justify-content:space-between;gap:12px}.paused{padding:12px;margin:8px 0;border:1px solid #f1b86455;border-radius:10px;background:var(--surface);color:#f1b864;font-size:12px}.paused>div{min-width:0;overflow-wrap:anywhere}.paused button{flex-shrink:0}.actions{margin-top:12px}@media(max-width:540px){.paused{align-items:flex-start;flex-direction:column}}
  `]
})
export class QuotaProtectionComponent {
  readonly protection = inject(QuotaProtectionService);
  readonly settings = input(false);
  readonly threadId = input('');
  readonly draft = signal<number | null>(null);
  readonly saved = signal(false);
  readonly valid = computed(() => { const value = this.draft() ?? this.protection.status()?.reservePercent ?? 30; return Number.isInteger(value) && value >= 1 && value <= 99; });
  readonly selectedPaused = computed(() => this.protection.status()?.paused.find(work => work.threadId === this.threadId()));
  async save(): Promise<void> {
    this.saved.set(await this.protection.save(this.draft() ?? this.protection.status()?.reservePercent ?? 30));
    if (this.saved()) this.draft.set(null);
  }
}
