// @vitest-environment jsdom
import '@angular/compiler';
import { expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
vi.mock('@angular/core', async (original) => ({...await original<any>(), ViewChild:()=>()=>{}, HostListener:()=>()=>{}}));
import { AppComponent } from './app.component';
it('selects Claude without touching Codex history or RPC', async () => {
  const rpc = vi.fn(); const select = vi.fn();
  const shell = { claude:{select}, selectedThread:signal<any>({id:'codex-thread'}), projectId:()=> 'p', connection:{rpc}, saveScrollPosition:()=>{}, error:signal(''), sessionMenuOpen:signal(true) };
  await AppComponent.prototype.selectThread.call(shell, {id:'claude:same',nativeId:'same',agentId:'claude'});
  expect(select).toHaveBeenCalledWith('same'); expect(rpc).not.toHaveBeenCalled(); expect(shell.selectedThread()).toBeNull();
});
it('blocks unsupported Codex session actions for a Claude selection', async () => {
  const rpc = vi.fn();
  await AppComponent.prototype.sessionAction.call({ claude:{selectedId:()=> 'same'}, selectedThread:()=>null, connection:{rpc} }, 'fork');
  expect(rpc).not.toHaveBeenCalled();
});
