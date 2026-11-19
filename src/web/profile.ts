import type { RoundResult, Seat } from '../shared/protocol.ts';
import { windLabel } from './rules.ts';
import { tileLabel } from '../shared/protocol.ts';

type Player = { name: string; avatar: number; registered: boolean; verified: boolean };
export let identity: { player: Player | null; activeRoom: string | null } = {
  player: null,
  activeRoom: null,
};
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new Error('暂时无法连接游戏服务，请检查网络后重试。');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError('游戏服务暂不可用，请稍后再试。', response.status);
  }
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || '请求失败，请重试', response.status);
  return data as T;
}
export async function refresh() {
  identity = await api<typeof identity>('/api/me');
}
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const avatars = ['梅', '兰', '竹', '菊'];
export function setupAccount(
  changed: (action: string) => Promise<void>,
  submitting: (action: string | null) => void,
) {
  const sessionUpdates = typeof BroadcastChannel === 'function' ? new BroadcastChannel('mawang-session') : null;
  const dialog = byId<HTMLDialogElement>('account-dialog');
  const form = byId<HTMLFormElement>('account-form');
  const modeButtons = byId('account-mode');
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  let mode = 'login';
  const status = byId('account-status');
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  avatars.forEach((v, i) => (field('avatar') as HTMLSelectElement).add(new Option(v, String(i))));
  const portrait = form.querySelector<HTMLElement>('.profile-portrait')!;
  function showAvatar() {
    const index = Number(field('avatar').value);
    portrait.style.backgroundPosition = (index % 2 ? '100%' : '0') + ' ' + (index >= 2 ? '100%' : '0');
  }
  field('avatar').addEventListener('change', showAvatar);
  const choices: Record<string, [string, string[]]> = {
    guest: ['游客入座', ['name', 'avatar']],
    profile: ['编辑资料', ['name', 'avatar']],
    register: ['注册账号', ['name', 'avatar', 'username', 'password', 'email']],
    login: ['登录账号', ['username', 'password']],
    forgot: ['找回密码', ['email']],
    reset: ['设置新密码', ['password']],
    verify: ['验证邮箱', []],
    resend: ['重发验证邮件', []],
    logout: ['退出账号', []],
  };
  function selectMode(action: string) {
    mode = action;
    for (const button of modeButtons.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === action));
    }
    const labels: Record<string,string> = { guest:'以游客身份入座', profile:'保存资料', forgot:'发送找回邮件',
      reset:'保存新密码', login:'登录', register:'创建账号', verify:'确认验证', resend:'发送验证邮件', logout:'退出账号' };
    submit.textContent = labels[action];
    byId('account-title').textContent = choices[action][0];
    const password = field('password') as HTMLInputElement;
    password.autocomplete = action === 'login' ? 'current-password' : 'new-password';
    password.minLength = action === 'login' ? 0 : 8;
    for (const item of ['name', 'avatar', 'username', 'password', 'email']) {
      const visible = choices[action][1].includes(item);
      field(item).parentElement!.hidden = !visible;
      field(item).required = visible;
    }
  }
  dialog.addEventListener('close', () => { field('password').value = ''; });
  async function open(tokenMode?: string) {
    if (!dialog.open) dialog.showModal();
    status.textContent = '正在读取…';
    form.hidden = true;
    modeButtons.replaceChildren();
    try {
      await refresh();
    } catch (e) {
      status.textContent = (e as Error).message;
      return;
    }
    const player = identity.player;
    status.textContent = '';
    byId('identity').hidden = !player;
    byId('identity').textContent = player
      ? (avatars[player.avatar] || '') +
        ' · ' +
        player.name +
        ' · ' +
        (player.registered ? '正式账号 · ' + (player.verified ? '邮箱已验证' : '邮箱未验证') : '游客')
      : '尚未入座';
    const items =
      tokenMode === 'register'
        ? ['login', 'register', 'forgot']
        : tokenMode
          ? [tokenMode]
          : player?.registered
            ? [
                'profile',
                ...(!player.verified ? ['resend'] : []),
                ...(!identity.activeRoom ? ['logout'] : []),
              ]
            : player ? ['profile', 'register', 'login', 'forgot'] : ['login', 'register', 'guest', 'forgot'];
    for (const key of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.mode = key;
      button.textContent = choices[key][0];
      button.onclick = () => {
        if (submit.disabled) return;
        field('password').value = '';
        status.textContent = '';
        selectMode(key);
      };
      modeButtons.append(button);
    }
    modeButtons.hidden = items.length === 1;
    form.hidden = false;
    field('name').value = player?.name || byId<HTMLInputElement>('nickname').value;
    field('avatar').value = String(player?.avatar || 0);
    showAvatar();
    if (tokenMode === 'register') {
      status.textContent = '创建好友桌需要正式账号。注册或登录后将自动开桌。';
    }
    selectMode(items[0]);
  }
  byId('account-open').onclick = () => void open();
  const url = new URL(location.href);
  const tokenMode = url.searchParams.has('reset')
    ? 'reset'
    : url.searchParams.has('verify')
      ? 'verify'
      : null;
  if (tokenMode) void open(tokenMode);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled || !choices[mode]) return;
    submit.disabled = true;
    status.textContent = '正在提交…';
    const action = mode;
    submitting(action);
    const payload: Record<string, string | number> = {};
    for (const name of choices[action][1])
      payload[name] = name === 'avatar' ? Number(field(name).value) : field(name).value;
    if (tokenMode === action) payload.token = url.searchParams.get(action) || '';
    try {
      await api(
        action === 'profile' ? '/api/profile' : '/api/auth/' + action,
        action === 'profile' ? 'PATCH' : 'POST',
        payload,
      );
      if (['guest', 'register', 'login', 'logout', 'reset'].includes(action)) sessionUpdates?.postMessage('changed');
      if (tokenMode === action) {
        url.searchParams.delete(action);
        history.replaceState(null, '', url);
      }
      field('password').value = '';
      await changed(action);
      if (!dialog.open) return;
      await open();
      status.textContent = ['forgot', 'resend'].includes(action) ? '请求已提交，请查看邮箱。' : '已完成';
    } catch (e) {
      status.textContent = (e as Error).message;
    } finally {
      submitting(null);
      submit.disabled = false;
    }
  };
  let historyGeneration = 0;
  const historyDialog = byId<HTMLDialogElement>('history-dialog');
  if (sessionUpdates) sessionUpdates.onmessage = () => {
    historyGeneration++;
    historyDialog.close();
    byId('history-list').replaceChildren();
  };
  historyDialog.addEventListener('close', () => {
    if (!historyDialog.open) historyGeneration++;
  });
  byId('history-open').onclick = async () => {
    const generation = ++historyGeneration;
    historyDialog.showModal();
    const list = byId('history-list');
    list.replaceChildren();
    const feedback = byId('history-status');
    const more = byId<HTMLButtonElement>('history-more');
    const retry = byId<HTMLButtonElement>('history-retry');
    const seen = new Set<string>();
    let cursor: string | null = null;
    let loading = false;
    type Match = {
      id: string;
      closed: boolean;
      rulesVersion: string;
      players: { seat: Seat; name: string; points: number }[];
      rounds: {
        number: number;
        banker: Seat;
        joker: number;
        dice: number[];
        multiplier: number;
        streakRound: number;
        result: RoundResult;
      }[];
    };
    async function loadPage() {
      if (loading) return;
      loading = true;
      retry.hidden = true;
      more.hidden = !cursor;
      more.disabled = true;
      feedback.textContent = '正在读取…';
      try {
        const path = '/api/history' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '');
        const { matches, nextCursor } = await api<{ matches: Match[]; nextCursor?: string | null }>(path);
        if (generation !== historyGeneration || !historyDialog.open) return;
        for (const m of matches) {
          if (seen.has(m.id)) continue;
          const entry = document.createElement('details'),
            title = document.createElement('summary');
          title.textContent =
            '房间 ' + m.id + ' · ' + m.rounds.length + ' 局 · ' + (m.closed ? '已结束' : '进行中');
          entry.append(title);
          const line = (v: string) => {
            const p = document.createElement('p');
            p.textContent = v;
            entry.append(p);
          };
          line('规则 ' + m.rulesVersion + ' · ' + m.players.map((p) => p.name + ' ' + p.points).join(' / '));
          for (const r of m.rounds) {
            const winner = m.players.find((p) => p.seat === r.result.winner);
            line(
              '第 ' +
                r.number +
                ' 局 · ' +
                (winner ? winner.name + (r.result.source === 'robKong' ? ' 抢杠胡' : ' 自摸') : '流局') +
                ' · ×' +
                r.multiplier +
                (r.streakRound ? ' · 翻倍第' + r.streakRound + '/3局' : ''),
            );
            const banker = m.players.find((player) => player.seat === r.banker);
            line(
              (banker?.name || '牌友') +
                '（' +
                windLabel(r.banker, r.banker, m.rulesVersion) +
                '风）坐庄 · 骰子 ' +
                r.dice.join('、') +
                ' · 财神 ' +
                tileLabel(r.joker),
            );
            if (m.rulesVersion === 'wj-2' && r.streakRound && r.result.source === 'draw')
              line('流局，本次连翻次数保留。');
            if (r.result.score)
              line(
                r.result.score.lines.map((s) => s.label + ' ' + s.points + '台').join('、') +
                  ' · 共 ' +
                  r.result.score.total +
                  ' 台',
              );
            line(
              m.players
                .map(
                  (p) =>
                    windLabel(p.seat, r.banker, m.rulesVersion) +
                    ' · ' +
                    p.name +
                    ' ' +
                    (r.result.deltas[p.seat] > 0 ? '+' : '') +
                    r.result.deltas[p.seat],
                )
                .join(' / '),
            );
          }
          list.append(entry);
          seen.add(m.id);
        }
        cursor = nextCursor || null;
        feedback.textContent = seen.size ? '' : '还没有牌局记录';
        more.hidden = !cursor;
      } catch (e) {
        if (generation !== historyGeneration || !historyDialog.open) return;
        feedback.textContent = (e as Error).message;
        retry.hidden = Boolean(cursor);
      } finally {
        loading = false;
        if (generation === historyGeneration) more.disabled = false;
      }
    }
    more.onclick = retry.onclick = loadPage;
    await loadPage();
  };
  return () => open('register');
}
