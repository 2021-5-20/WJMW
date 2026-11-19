import { winds, seatWind, type Seat } from '../shared/protocol.ts';

export function windLabel(seat: Seat, banker: Seat, version?: string) {
  return winds[seatWind(seat, banker, version ?? 'wj-1')];
}

export function displayRules(version: string) {
  const current = version === 'wj-2';
  const entries = [
    '四人一桌，可碰、可杠，两台起胡。胡牌方式为自摸或抢补杠。',
    current
      ? '庄家为东风，其他三家依座次为南、西、北。换庄后，自风随庄位轮转。'
      : '东、南、西、北依最初座位固定，自风按座位计算。',
    '金张为中、发、白。普通明杠 1 台，暗杠 2 台。自风或金张成刻加 1 台，成杠也加 1 台。',
    '底胡 1 台。胡牌时没有财神，加 1 台：本局曾打出财神叫丢搭，否则叫无百搭。绕搭加 1 台，指用财神配对单钓将牌。绕搭不能抢杠；丢搭且手中已无财神，也不能抢杠。',
    '碰碰胡 3 台：除将牌外全是刻或杠。混一色 3 台：一种花色配字牌。清一色 10 台：全是一种花色。大吊车 1 台：四组已碰杠，手里单钓一对。',
    '抢他人补杠胡牌加 2 台；杠后补牌自摸叫杠上开花，加 1 台；正常摸到最后一张自摸叫海底捞月，加 1 台。',
    '无人碰杠时，庄家起手胡为天胡；闲家首次摸牌自摸为地胡，各加 10 台。',
    '自摸由其他三家各付总台数；抢杠由补杠者付三份。流局四家均为 0 分。本桌没有三碰承包。',
    current
      ? '三财神直接胡仅限自摸：手握三张财神但牌型未成，仅计 10 台再乘本局倍率。已成通常胡牌牌型时，三财神加 10 台，并叠加符合条件的其他台数。'
      : '通常和牌牌型中有三张财神，加 10 台。',
    '两枚骰子点数相同称为豹子。掷出豹子，或翻到风牌、金张作财神，当局翻倍。',
    current
      ? '豹子与字牌财神同时出现，从当局起连翻三局。流局不消耗次数，下局沿用本次序号。再次同时触发，从当局重新计三局。'
      : '两项同时触发，从当局起连续三局翻倍，流局也计入。',
  ];
  document.getElementById('rules-title')!.textContent = '吴江麻将玩法 · ' + version;
  document.getElementById('rules-list')!.replaceChildren(
    ...entries.map((text) => {
      const entry = document.createElement('li');
      entry.textContent = text;
      return entry;
    }),
  );
  (document.getElementById('rules-dialog') as HTMLDialogElement).showModal();
}
