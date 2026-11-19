import { Client } from '@colyseus/sdk';
import type { Room } from '@colyseus/sdk';
import { tileLabel, winds } from '../shared/protocol.ts';
import type { Action, RoomView, Seat, Tile } from '../shared/protocol.ts';
import type { createTable } from './table.ts';
import { ApiError, avatars, api, refresh, identity, setupAccount } from './profile.ts';
import { displayRules, windLabel } from './rules.ts';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing #${id}`);
  return result as T;
}

const lobby = element('lobby');
const gameShell = element('game-shell');
const form = element<HTMLFormElement>('room-form');
const nickname = element<HTMLInputElement>('nickname');
const roomCode = element<HTMLInputElement>('room-code');
const createButton = element<HTMLButtonElement>('create-room');
const joinButton = element<HTMLButtonElement>('join-room');
const lobbyStatus = element('lobby-status');
const connectionStatus = element('connection-status');
const waiting = element('waiting');
const playing = element('playing');
const settlement = element('settlement');
const leaveButton = document.querySelector<HTMLButtonElement>('[data-command="leave"]')!;
const leaveDialog = element<HTMLDialogElement>('leave-dialog');
const startButton = element<HTMLButtonElement>('start-round');
const readyButton = element<HTMLButtonElement>('ready-round');
const actionList = element('action-list');
const toast = element('toast');
const tableMedia = window.matchMedia('(orientation: portrait) and (max-width: 760px)');
const client = new Client(location.origin);


let room: Room | null = null;
let view: RoomView | null = null;
let table: ReturnType<typeof createTable> | null = null;
let tableLoading = false;
let dropped = false;
let busy = false;
let invitationBlocked = false;
let pendingCreate = false;
let authRoom: Room | null = null;
let revokedDuringAuth = false;
let submittedRevision: number | null = null;
let toastTimer = 0;

const commandText: Record<Action['type'], string> = {
  discard: '出牌', pong: '碰', openKong: '杠', closedKong: '暗杠', addedKong: '补杠', hu: '胡', pass: '过',
};

function showNotice(message: string, duration = 3200): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  if (duration) toastTimer = window.setTimeout(() => { toast.hidden = true; }, duration);
}

function readStorage(storage: 'sessionStorage' | 'localStorage', key: string): string | null {
  try { return window[storage].getItem(key); } catch { return null; }
}

function writeStorage(storage: 'sessionStorage' | 'localStorage', key: string, value: string | null): void {
  try {
    if (value === null) window[storage].removeItem(key);
    else window[storage].setItem(key, value);
  } catch { /* Browsers may disable storage without affecting a live session. */ }
}

function setBusy(active: boolean): void {
  busy = active;
  createButton.disabled = active || Boolean(createButton.hidden);
  joinButton.disabled = active || invitationBlocked;
  form.setAttribute('aria-busy', String(active));
}

function idFrom(input: string): string {
  try { return new URL(input).searchParams.get('room') ?? input; } catch { return input; }
}

function urlFor(id: string): URL {
  const url = new URL('/', location.origin);
  url.searchParams.set('room', id);
  url.hash = '';
  return url;
}

function bindRoom(joined: Room): void {
  room = joined;
  element('account-open').textContent = identity.player?.registered ? '账号资料' : '游客资料';
  joined.reconnection.enabled = false;
  view = null;
  dropped = false;
  submittedRevision = null;
  history.replaceState(null, '', urlFor(joined.roomId));
  roomCode.value = joined.roomId;
  joined.onMessage('view', (snapshot: RoomView) => {
    if (room !== joined) return;
    if (snapshot.closed && !snapshot.round) { void joined.leave(); return; }
    if (view?.roundNumber !== snapshot.roundNumber || view.round?.revision !== snapshot.round?.revision) submittedRevision = null;
    view = snapshot;
    dropped = false;
    render();
  });
  joined.onMessage('notice', (message: string) => {
    if (room !== joined) return;
    submittedRevision = null;
    showNotice(message);
    render();
  });
  joined.onDrop(() => {
    if (room !== joined) return;
    dropped = true;
    render();
  });
  joined.onLeave(async code => {
    if (room !== joined) return;
    if (code === 4003 && authRoom === joined) {
      revokedDuringAuth = true;
      dropped = true;
      render();
      return;
    }
    returnToLobby(false);
    if (code === 4003) {
      element<HTMLDialogElement>('history-dialog').close();
      element('history-list').replaceChildren();
      await initialise(false);
      lobbyStatus.textContent = '登录状态已失效，请重新登录。';
      return;
    }
    if (code === 4001) { await initialise(false); lobbyStatus.textContent = '该座位已在另一设备打开。'; return; }
    if ([1001,1005,1006,4010].includes(code)) {
      setBusy(true);
      lobbyStatus.textContent = '牌桌连接中断，正在重新连接…';
      try {
        for (const delay of [500,1500,3000,6000]) {
          await new Promise(resolve => setTimeout(resolve, delay));
          try { await enter(joined.roomId); return; } catch(error) {
            if (error instanceof ApiError && error.status >= 400 && error.status < 500) break;
          }
        }
      } finally { setBusy(false); }
    }
    await initialise(false);
    if (!room && !lobbyStatus.textContent) lobbyStatus.textContent = '当前无法连接牌桌，请检查网络后重新入座。';
  });
  joined.send('sync');
  window.setTimeout(() => {
    if (room === joined && !view) lobbyStatus.textContent = '已连上房间，正在等待入座信息。';
  }, 3000);
}

function returnToLobby(clearId: boolean): void {
  room = null;
  view = null;
  dropped = false;
  submittedRevision = null;
  table?.destroy();
  table = null;
  invitationBlocked = false;
  if (clearId) {
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    roomCode.value = '';
    createButton.hidden = false;
    createButton.disabled = busy;
  }
  gameShell.hidden = true;
  leaveButton.hidden = true;
  lobby.hidden = false;
  lobbyStatus.textContent = '';
  delete document.body.dataset.roomPhase;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || room) return;
  const mode = (event.submitter as HTMLButtonElement | null)?.value ?? (createButton.hidden ? 'join' : 'create');
  const name = nickname.value.trim();
  const id = idFrom(roomCode.value.trim());
  if (mode === 'create' && !identity.player?.registered) {
    pendingCreate = true;
    await openRegistration();
    return;
  }
  if (!name) {
    nickname.focus();
    lobbyStatus.textContent = '请输入昵称。';
    return;
  }
  if (mode === 'join' && !id) {
    roomCode.focus();
    lobbyStatus.textContent = '请输入房间号。';
    return;
  }
  setBusy(true);
  lobbyStatus.textContent = mode === 'join' ? '正在加入…' : '正在创建…';
  try {
    await refresh();
    if (!identity.player) await api('/api/auth/guest','POST',{name,avatar:0});
    else if (identity.player.name !== name) await api('/api/profile','PATCH',{name,avatar:identity.player.avatar});
    await refresh();
    await enter(identity.activeRoom || (mode === 'join' ? id : ''));
    writeStorage('localStorage', 'wujiang-name', name);

  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    lobbyStatus.textContent = /[\u4e00-\u9fa5]/.test(reason)
      ? reason
      : mode === 'join' ? '加入失败。请检查房间号，确认房间还有空位。' : '建房失败。请检查连接后再试。';
  } finally {
    setBusy(false);
  }
});

roomCode.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit(joinButton);
  }
});

function sendAction(action: Action): void {
  const round = view?.round;
  if (!round || !room || dropped || submittedRevision === round.revision) return;
  submittedRevision = round.revision;
  room.send('action', { revision: round.revision, action });
  for (const button of actionList.querySelectorAll('button')) button.disabled = true;
}

async function ensureTable(): Promise<void> {
  if (table || tableLoading || tableMedia.matches) return;
  tableLoading = true;
  try {
    const { createTable } = await import('./table.ts');
    if (!view?.round || playing.hidden) return;
    table = createTable(element('table-stage'), tile => sendAction({ type: 'discard', tile }));
    table.update(view);
  } catch (error) {
    console.error(error);
    showNotice('牌桌加载失败，请刷新重试。');
  } finally {
    tableLoading = false;
  }
}

function render(): void {
  if (!view) return;
  lobby.hidden = true;
  gameShell.hidden = false;
  leaveButton.hidden = false;
  element('room-number').textContent = view.id;
  connectionStatus.textContent = dropped ? '断线重连中…' : '';
  const round = view.round;
  waiting.hidden = Boolean(round);
  playing.hidden = !round || round.phase === 'settled';
  settlement.hidden = !round || round.phase !== 'settled';
  document.body.dataset.roomPhase = !playing.hidden ? 'playing' : !settlement.hidden ? 'settled' : 'waiting';
  if (!round) renderWaiting(view);
  else if (round.phase === 'settled') renderSettlement(view);
  else {
    renderActions(view);
    renderCountdown();
    table?.update(view);
    table?.refresh();
    void ensureTable();
  }
}

function badge(seat: Seat): HTMLElement {
  const marker = document.createElement('span');
  marker.className = 'seat-badge';
  marker.dataset.seat = String(seat);
  const wind = document.createElement('span');
  wind.textContent = winds[seat];
  marker.append(wind);
  return marker;
}

function renderWaiting(snapshot: RoomView): void {
  const count = snapshot.players.filter(player => player.connected).length;
  const isHost = snapshot.host === snapshot.seat;
  element('waiting-status').textContent = count < 4 ? `已入座 ${count}/4，复制邀请发给牌友。` : isHost ? '四人到齐，可以开局。' : '四人到齐，等待房主开局。';
  const seats = winds.map((_, index) => {
    const seat = index as Seat;
    const player = snapshot.players.find(item => item.seat === seat);
    const slot = document.createElement('div');
    slot.className = `waiting-seat${player ? ' filled' : ''}`;
    const name = document.createElement('strong');
    name.textContent = player ? avatars[player.avatar ?? 0]+' · '+player.name : '待入座';
    const note = document.createElement('span');
    const tags = [];
    if (player?.seat === snapshot.host) tags.push('房主');
    if (player?.seat === snapshot.seat) tags.push('你');
    if (player?.connected === false) tags.push('离线');
    note.textContent = tags.join(' · ');
    note.hidden = !tags.length;
    slot.append(badge(seat), name, note);
    return slot;
  });
  element('waiting-seats').replaceChildren(...seats);
  startButton.hidden = !isHost;
  startButton.disabled = dropped || count < 4;
}

function renderActions(snapshot: RoomView): void {
  const { round, seat, players } = snapshot;
  if (!round) return;
  const ownTurn = round.turn === seat;
  const actor = players.find(player => player.seat === round.turn)?.name;
  const canDiscard = round.actions.some(action => action.type === 'discard');
  let message = ownTurn ? '轮到你了' : `等待${actor ?? '牌友'}出牌`;
  if (round.phase === 'response') message = round.actions.length ? '请选择操作' : '等待其他牌友操作';
  if (canDiscard) message = '点一下选牌，再点一下打出';
  if (dropped) message = '正在恢复牌局…';
  element('turn-status').textContent = message;
  const buttons = round.actions.filter(action => action.type !== 'discard').map(action => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.type === 'pass' ? 'secondary-button' : 'primary-button';
    button.dataset.action = action.type;
    const extra = action.tile !== undefined && ['closedKong', 'addedKong'].includes(action.type) ? ` ${tileLabel(action.tile)}` : '';
    button.textContent = commandText[action.type] + extra;
    button.disabled = dropped || submittedRevision === round.revision;
    button.addEventListener('click', () => sendAction(action));
    return button;
  });
  actionList.replaceChildren(...buttons);
}

function renderCountdown(): void {
  if (playing.hidden) return;
  const deadline = view?.deadline;
  const countdown = element('countdown');
  const seconds = deadline ? `${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} 秒` : '';
  if (countdown.textContent !== seconds) countdown.textContent = seconds;
}

function scoreRow(label: string, value: string, className = 'score-line', valueClass = ''): HTMLElement {
  const row = document.createElement('div');
  row.className = className;
  const title = document.createElement('span');
  title.textContent = label;
  const points = document.createElement('strong');
  points.className = valueClass;
  points.textContent = value;
  row.append(title, points);
  return row;
}

function renderSettlement(snapshot: RoomView): void {
  const round = snapshot.round;
  const result = round?.result;
  if (!round || !result) return;
  const roster = snapshot.settlementPlayers ?? snapshot.players;
  const winner = roster.find(player => player.seat === result.winner);
  const score = result.score;
  const carry = snapshot.rulesVersion === 'wj-2' && round.streakRound && result.source === 'draw' ? '（流局保留次数）' : '';
  const streak = round.streakRound ? ` · 翻倍第${round.streakRound}/3局${carry}` : '';
  element('settlement-round').textContent = `第 ${snapshot.roundNumber} 局 · ×${round.multiplier}${streak} · ${snapshot.rulesVersion || 'wj-1'}`;
  const source = result.source === 'robKong' ? '抢杠胡' : '自摸';
  element('settlement-title').textContent = result.winner === null ? '流局' : `${winner?.name ?? '牌友'}${source === '抢杠胡' ? ' 抢杠胡' : ' 自摸胡'}`;
  element('settlement-total').textContent = score ? `${score.total} 台` : '';
  const tiles = result.winningHand?.map(tile => {
    const node = document.createElement('span');
    node.className = `score-tile${tile === round.joker ? ' joker' : ''}`;
    node.textContent = tileLabel(tile);
    return node;
  }) ?? [];
  element('winning-hand').replaceChildren(...tiles);
  const lines = score?.lines.map(line => scoreRow(line.label, `+${line.points} 台`)) ?? [];
  if (score && round.multiplier > 1) lines.push(scoreRow('本局翻倍', `${score.base} × ${round.multiplier}`));
  element('score-lines').replaceChildren(...lines);
  element('final-scores').replaceChildren(...roster.map(player => {
    const delta = result.deltas[player.seat] ?? 0;
    return scoreRow(`${windLabel(player.seat, round.banker, snapshot.rulesVersion)} · ${player.name}`, `${delta > 0 ? '+' : ''}${delta}（共 ${player.points}）`, 'final-player', `delta ${delta < 0 ? 'negative' : 'positive'}`);
  }));
  const readyCount = snapshot.players.filter(player => player.ready).length;
  const alreadyReady = snapshot.players.some(player => player.seat === snapshot.seat && player.ready);
  readyButton.disabled = Boolean(snapshot.closed) || dropped || alreadyReady;
  readyButton.textContent = snapshot.closed ? '牌桌已结束' : alreadyReady ? `已准备 ${readyCount}/4` : '准备下一局';
}

async function copyInvite(): Promise<void> {
  if (!room) return;
  const text = urlFor(room.roomId).href;
  try {
    await navigator.clipboard.writeText(text);
    showNotice('邀请链接已复制');
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.className = 'sr-only';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    showNotice(copied ? '邀请链接已复制' : `复制此链接　${text}`, copied ? 3200 : 10000);
  }
}

async function leave(): Promise<void> {
  const previous = room;
  if (!previous) return;
  if (!view?.closed) previous.send('leave');
  returnToLobby(true);
  await previous.leave();
  await initialise(false);
}

document.addEventListener('click', event => {
  if (!(event.target instanceof HTMLElement)) return;
  const command = event.target.closest<HTMLButtonElement>('button[data-command]')?.dataset.command;
  switch (command) {
    case 'rules': displayRules(view ? view.rulesVersion || 'wj-1' : 'wj-2'); break;
    case 'leave':
      if (view?.closed) void leave();
      else {
        element('leave-explanation').textContent = view?.round && view.round.phase !== 'settled'
          ? '暂离后系统会在超时时替你出牌。你可以从首页返回本桌。'
          : '离桌会结束这张好友桌，所有牌友都将无法继续开局。';
        leaveDialog.returnValue = '';
        leaveDialog.showModal();
      }
      break;
    case 'invite': void copyInvite(); break;
    case 'start': if (!dropped) room?.send('start'); break;
    case 'ready': if (!dropped) room?.send('ready'); break;
  }
});

leaveDialog.addEventListener('close', () => { if (leaveDialog.returnValue === 'leave') void leave(); });
tableMedia.addEventListener('change', () => {
  if (!playing.hidden) {
    table?.refresh();
    void ensureTable();
  }
});
window.setInterval(renderCountdown, 250);

const resume = element<HTMLButtonElement>('resume');
async function enter(id: string) {
  const reservation = await api<Parameters<Client['consumeSeatReservation']>[0]>(id ? '/api/rooms/'+encodeURIComponent(id)+'/seat' : '/api/rooms','POST',{});
  bindRoom(await client.consumeSeatReservation(reservation));
}
async function initialise(auto=true) {
  setBusy(true);
  try {
    await refresh();
    nickname.value = identity.player?.name || readStorage('localStorage','wujiang-name') || '';
    const invitation = new URL(location.href).searchParams.get('room');
    resume.hidden = !identity.activeRoom;
    form.hidden = Boolean(identity.activeRoom);
    element('account-open').textContent = identity.player ? (identity.player.registered ? '账号资料' : '游客资料') : '登录 / 游客';
    resume.textContent = '返回牌桌 '+(identity.activeRoom || '');
    if (identity.activeRoom && invitation === identity.activeRoom && auto) await enter(invitation);
    else if (invitation) {
      roomCode.value = invitation;
      createButton.hidden = true;
      invitationBlocked = true;
      const info = await api<{count:number,status:string}>('/api/rooms/'+encodeURIComponent(invitation));
      invitationBlocked = (info.count >= 4 || info.status === 'closed') && identity.activeRoom !== invitation;
      lobbyStatus.textContent = info.status === 'closed' ? '邀请的牌桌已关闭' : '邀请牌桌 · '+info.count+'/4 人'+(info.count===4?' · 已满员':'');
    }
  } catch(error) { lobbyStatus.textContent = (error as Error).message; }
  finally { setBusy(false); }
}
roomCode.addEventListener('input', () => {
  invitationBlocked=false;
  createButton.hidden=false;
  setBusy(busy);
});
resume.onclick = async () => {
  if (busy || !identity.activeRoom) return;
  setBusy(true);
  try { await enter(identity.activeRoom); } catch(e) { lobbyStatus.textContent=(e as Error).message; } finally { setBusy(false); }
};
const openRegistration = setupAccount(async action => {
  if (pendingCreate && (action === 'login' || action === 'register')) {
    pendingCreate=false;
    element<HTMLDialogElement>('account-dialog').close();
    setBusy(true);
    try {
      await refresh();
      await enter(identity.activeRoom || '');
    } catch(error) {
      await initialise(false);
      lobbyStatus.textContent = (error as Error).message;
    } finally { setBusy(false); }
    return;
  }
  if (authRoom && room !== authRoom) throw new Error('原座位连接已结束，请从首页返回。');
  if (!room) {
    await initialise(false);
    const invitation = new URL(location.href).searchParams.get('room');
    if (invitation && ['login', 'register', 'guest'].includes(action) && !invitationBlocked) {
      await enter(identity.activeRoom || invitation);
      element<HTMLDialogElement>('account-dialog').close();
    }
  } else if (['login','register','profile'].includes(action)) {
    await refresh();
    const previous = room;
    room = null;
    try { await enter(previous.roomId); } catch(error) { returnToLobby(false); await initialise(false); throw error; }
    finally { await previous.leave(); }
  }
}, action => {
  if (action) {
    authRoom = ['register', 'login', 'profile'].includes(action) ? room : null;
    revokedDuringAuth = false;
  } else {
    if (revokedDuringAuth && authRoom && room === authRoom) {
      returnToLobby(false);
      void initialise(false);
    }
    authRoom = null;
    revokedDuringAuth = false;
  }
});
element('account-dialog').addEventListener('close', () => { pendingCreate = false; });
void initialise();
