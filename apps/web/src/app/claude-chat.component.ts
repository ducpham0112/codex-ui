import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { ClaudeService } from './claude.service';
import { renderMarkdown } from './markdown';
@Component({selector:'claude-chat', standalone:true, imports:[FormsModule,JsonPipe], templateUrl:'./claude-chat.component.html', styleUrl:'./claude-chat.component.css'})
export class ClaudeChatComponent {
  readonly claude = inject(ClaudeService);
  readonly markdown = renderMarkdown;
  send(): void { const session = this.claude.selected(); if(session) void this.claude.sendTurn(session.id, this.claude.draftFor(session.id)); }
  retry(): void { const session = this.claude.selected(); const pending = session && this.claude.pendingTurn(session.id); if(session && pending) void this.claude.sendTurn(session.id,pending.prompt); }
}
