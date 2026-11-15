import { Component, input, output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClaudeService, CLAUDE_MODELS } from './claude.service';
@Component({selector:'agent-settings', standalone:true, imports:[FormsModule], templateUrl:'./agent-settings.component.html'})
export class AgentSettingsComponent {
  readonly claude = inject(ClaudeService);
  readonly codexConnected = input(false);
  readonly codexLoginRequired = input(false);
  readonly codexModels = input<Array<{key:string;label:string}>>([]);
  readonly codexLogin = output<void>();
  readonly codexRefresh = output<void>();
  readonly codexLogout = output<void>();
  readonly models = CLAUDE_MODELS;
  readonly codexDefault = signal(localStorage.getItem('codex.defaultModelPair') ?? '');
  saveCodexDefault(value: string): void { this.codexDefault.set(value); localStorage.setItem('codex.defaultModelPair',value); }
}
