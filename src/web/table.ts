import Phaser from 'phaser';
import { windLabel } from './rules.ts';
import { tileLabel } from '../shared/protocol.ts';
import type { PublicMeld, RoomView, Seat, Tile } from '../shared/protocol.ts';

const width = 1100;
const height = 560;
const ink = '#173d38';
const cream = 0xfff5db;
const jade = 0x22715d;
const gold = 0xedbc77;
const coral = 0xdf765c;
const night = 0x0d252a;
const gilt = '#f1cc90';
const guestColors = [0xa64536, 0x5c6385, 0x47735e, 0xa66438] as const;
const guestFur = [0xffb46c, 0xffdedf, 0xffeed7, 0xf49467] as const;
const font = '"Microsoft YaHei", "PingFang SC", sans-serif';
const pipLayouts: number[][] = [
  [], [4], [1, 7], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8],
  [0, 2, 3, 5, 6, 8], [0, 1, 2, 3, 5, 6, 8], [0, 1, 2, 3, 5, 6, 7, 8], [0, 1, 2, 3, 4, 5, 6, 7, 8],
];

class TeaTable extends Phaser.Scene {
  snapshot: RoomView | null = null;
  drawLayer: Phaser.GameObjects.Container | null = null;
  onDiscard: (tile: Tile) => void;
  selection = -1;
  revision = -1;
  roundNumber = -1;

  constructor(onDiscard: (tile: Tile) => void) {
    super('tea-table');
    this.onDiscard = onDiscard;
  }

  preload(): void {
    this.load.image('lantern-table', '/lantern-table.webp');
    this.load.image('tea-guests', '/tea-guests.webp');
  }

  create(): void {
    this.paintBoard();
    this.preparePortraits();
    this.drawLayer = this.add.container();
    this.redraw();
    this.scale.canvas.setAttribute('tabindex', '0');
    this.scale.canvas.setAttribute('aria-label', '吴江牌桌。使用左右方向键选牌，回车出牌。');
    this.scale.canvas.addEventListener('keydown', this.keyboard);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.redraw, this);
  }

  private displayHand(): Tile[] {
    const round = this.snapshot?.round;
    if (!round) return [];
    const hand = [...round.hand];
    const recent = round.drawnTile;
    if (recent !== undefined) {
      const index = hand.indexOf(recent);
      if (index >= 0) hand.push(...hand.splice(index, 1));
    }
    return hand;
  }

  private keyboard = (event: KeyboardEvent): void => {
    if (document.querySelector('dialog[open]') || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    const hand = this.displayHand();
    if (!hand.length) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      this.selection = this.selection < 0 ? (direction > 0 ? 0 : hand.length - 1) : (this.selection + direction + hand.length) % hand.length;
      this.redraw(true);
    }
    if (event.key === 'Enter' && this.selection >= 0) {
      event.preventDefault();
      this.discard(hand[this.selection]);
    }
  };

  setView(view: RoomView): void {
    if (this.revision !== view.round?.revision || this.roundNumber !== view.roundNumber) this.selection = -1;
    this.revision = view.round?.revision ?? -1;
    this.roundNumber = view.roundNumber;
    this.snapshot = view;
    this.redraw();
  }

  private paintBoard(): void {
    const board = this.add.graphics();
    board.fillStyle(night).fillRect(0, 0, width, height);
    if (this.textures.exists('lantern-table')) {
      this.add.image(width / 2, height / 2, 'lantern-table').setDisplaySize(width, height);
    } else {
      board.fillStyle(0x472b2b).fillRoundedRect(6, 10, 1088, 548, 32);
      board.fillStyle(0xa54837).fillRoundedRect(6, 4, 1088, 548, 32);
      board.lineStyle(2, gold, .85).strokeRoundedRect(12, 10, 1076, 536, 26);
      board.fillStyle(0x572e2d).fillRoundedRect(19, 16, 1062, 524, 22);
      board.fillStyle(0x163f3e).fillRoundedRect(24, 21, 1052, 514, 20);
      board.lineStyle(1, gold, .45).strokeRoundedRect(25, 22, 1050, 512, 20);
    }

    const markings = this.add.graphics();
    markings.fillStyle(night, .29).fillRoundedRect(222, 112, 656, 330, 35);
    markings.lineStyle(1, gold, .25).strokeRoundedRect(222, 112, 656, 330, 35);
    markings.lineStyle(1, gold, .13).strokeRoundedRect(230, 120, 640, 314, 29);
    markings.lineStyle(1, gold, .26).lineBetween(400, 133, 400, 420);
    markings.lineBetween(700, 133, 700, 420);
    for (const x of [222, 878]) {
      for (const y of [148, 406]) this.inlay(markings, x, y, 5, gold, .6);
    }

    // The low rim of the porcelain hand tray anchors the face-up tiles.
    markings.fillStyle(night, .78).fillRoundedRect(102, 475, 896, 75, 22);
    markings.lineStyle(1, gold, .38).strokeRoundedRect(102, 475, 896, 75, 22);
    markings.lineStyle(1, gold, .16).lineBetween(128, 539, 973, 539);
  }

  private inlay(graphics: Phaser.GameObjects.Graphics, x: number, y: number, size: number, color: number, alpha = 1): void {
    graphics.fillStyle(color, alpha).beginPath().moveTo(x, y - size).lineTo(x + size, y)
      .lineTo(x, y + size).lineTo(x - size, y).closePath().fillPath();
  }

  private preparePortraits(): void {
    if (!this.textures.exists('tea-guests')) return;
    const atlas = this.textures.get('tea-guests').getSourceImage();
    if (!(atlas instanceof HTMLImageElement)) return;
    const cellWidth = atlas.naturalWidth / 2;
    const cellHeight = atlas.naturalHeight / 2;
    const faceSize = Math.min(cellWidth, cellHeight) * .82;
    for (let seat = 0; seat < 4; seat++) {
      const portrait = this.textures.createCanvas(`guest-${seat}`, 96, 96);
      if (!portrait) continue;
      const context = portrait.getContext();
      context.beginPath();
      context.arc(48, 48, 47.5, 0, Math.PI * 2);
      context.clip();
      const x = (seat % 2 + .5) * cellWidth - faceSize / 2;
      const y = (Math.floor(seat / 2) + .5) * cellHeight - faceSize / 2;
      context.drawImage(atlas, x, y, faceSize, faceSize, 0, 0, 96, 96);
      portrait.refresh();
    }
  }

  private redraw(animate?: boolean): void {
    const layer = this.drawLayer;
    const view = this.snapshot;
    if (!layer || !view?.round) return;
    layer.removeAll(true);
    const round = view.round;
    const compact = this.scale.displaySize.height < 390;
    const relativeSeats = [0, 1, 2, 3].map(offset => ((view.seat + offset) % 4) as Seat);
    const [self, right, opposite, left] = relativeSeats;
    this.seat(self, 123, compact ? 448 : 491);
    this.seat(right, 977, 156);
    this.seat(opposite, 382, 54);
    this.seat(left, 123, 156);
    this.backRow(opposite, 459, 56, 14, 0);
    this.backRow(left, 98, 203, 14, 1);
    this.backRow(right, 1003, 203, 14, 1);
    this.discards(relativeSeats);
    this.melds(round.players[opposite].melds, 690, 55, 13);
    this.melds(round.players[left].melds, 129, 415, 12);
    this.melds(round.players[right].melds, 968, 415, 12);
    this.melds(round.players[self].melds, 817, 450, 20, round.joker);
    this.roundMedallion(view);
    const tileWidth = compact ? 59 : 47;
    const step = tileWidth + 4;
    const playable = new Set(round.actions.filter(action => action.type === 'discard').map(action => action.tile));
    const hand = this.displayHand();
    const drawnGap = round.drawnTile === undefined ? 0 : compact ? 11 : 14;
    const x = 550 - ((hand.length - 1) * step + drawnGap) / 2;
    hand.forEach((tile, index) => {
      const spot = x + index * step + (index === hand.length - 1 ? drawnGap : 0);
      const raised = index === this.selection;
      const y = raised ? 496 : 509;
      const card = this.tile(spot, y, tile, tileWidth, tile === round.joker, raised);
      if (raised && animate === true && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        card.y = y + 10;
        this.tweens.add({ targets: card, y, duration: 110, ease: 'Quad.easeOut' });
      }
      if (playable.has(tile)) {
        card.setInteractive({
          hitArea: new Phaser.Geom.Rectangle(-step / 2, -tileWidth * .7, step, tileWidth * 1.55),
          hitAreaCallback: Phaser.Geom.Rectangle.Contains,
          useHandCursor: true,
        });
        card.on('pointerup', () => {
          if (this.selection === index) this.discard(tile);
          else {
            this.selection = index;
            this.redraw(true);
          }
        });
      }
    });
  }

  private discard(tile: Tile): void {
    if (!this.snapshot?.round?.actions.some(action => action.type === 'discard' && action.tile === tile)) return;
    this.onDiscard(tile);
  }

  private roundMedallion(view: RoomView): void {
    const round = view.round!;
    const frame = this.shape();
    frame.fillStyle(0x06191b, .55).fillRoundedRect(422, 183, 256, 148, 32);
    frame.fillStyle(0x133236).fillRoundedRect(422, 177, 256, 148, 32);
    frame.lineStyle(2, gold, .8).strokeRoundedRect(422, 177, 256, 148, 32);
    frame.lineStyle(1, gold, .32).strokeRoundedRect(428, 183, 244, 136, 27);
    frame.lineStyle(1, gold, .35).lineBetween(453, 216, 647, 216);
    frame.lineBetween(558, 226, 558, 285);
    for (const x of [438, 662]) this.inlay(frame, x, 251, 7, gold);
    this.text(550, 200, `第 ${view.roundNumber} 局　·　余 ${round.wallCount} 张`, 18, gilt).setOrigin(.5);
    this.die(480, 248, round.dice[0]);
    this.die(521, 248, round.dice[1]);
    this.tile(608, 248, round.joker, 33, true);
    this.text(500, 280, '骰子', 14, '#d2ddd0').setOrigin(.5);
    this.text(608, 280, '财神', 14, gilt).setOrigin(.5);
    const bonus = round.streakRound ? `翻倍第${round.streakRound}/3局` : round.multiplier === 2 ? '本局 ×2' : '';
    if (bonus) {
      frame.fillStyle(0x9e3e32).fillRoundedRect(482, 297, 136, 25, 12);
      frame.lineStyle(1, gold, .8).strokeRoundedRect(482, 297, 136, 25, 12);
      this.text(550, 309, bonus, 15, '#fff0d3').setOrigin(.5);
    } else if (round.pending) {
      this.text(550, 305, round.pending.kind === 'addedKong' ? '等待抢杠' : '等待碰杠', 14, gilt).setOrigin(.5);
    }
  }

  private shape(): Phaser.GameObjects.Graphics {
    const graphics = this.add.graphics();
    this.drawLayer?.add(graphics);
    return graphics;
  }

  private text(x: number, y: number, text: string, size: number, color = ink): Phaser.GameObjects.Text {
    const label = this.add.text(x, y, text, { fontFamily: font, fontSize: size, color, fontStyle: 'bold' });
    this.drawLayer?.add(label);
    return label;
  }

  private seat(seat: Seat, x: number, y: number): void {
    const view = this.snapshot!;
    const player = view.players.find(candidate => candidate.seat === seat);
    const active = view.round!.turn === seat && view.round!.phase === 'turn';
    const base = this.shape();
    const avatar = x - 52;
    const portraitIndex = player?.avatar ?? seat;
    base.fillStyle(0x071a1f, .6).fillRoundedRect(x - 76, y - 18, 151, 48, 15);
    if (active) {
      base.fillStyle(gold, .24).fillRoundedRect(x - 82, y - 28, 163, 57, 19);
      this.inlay(base, x + 76, y, 8, gold);
    }
    base.fillStyle(active ? 0x8d3e35 : 0x122e34).fillRoundedRect(x - 76, y - 23, 152, 48, 15);
    base.lineStyle(active ? 2 : 1, gold, active ? .95 : .55).strokeRoundedRect(x - 76, y - 23, 152, 48, 15);
    base.fillStyle(active ? gold : 0x9d8152).fillCircle(avatar, y, 24);
    base.fillStyle(guestColors[portraitIndex]).fillCircle(avatar, y, 21.5);
    const portrait = `guest-${portraitIndex}`;
    if (this.textures.exists(portrait)) {
      const image = this.add.image(avatar, y, portrait).setDisplaySize(43, 43);
      if (player?.connected === false) image.setAlpha(.65);
      this.drawLayer?.add(image);
    } else {
      base.fillStyle(guestFur[portraitIndex]).fillCircle(avatar - 10, y - 9, 7).fillCircle(avatar + 10, y - 9, 7).fillEllipse(avatar, y + 1, 30, 26);
      base.fillStyle(coral).fillCircle(avatar - 9, y + 4, 2.6).fillCircle(avatar + 9, y + 4, 2.6);
      base.fillStyle(0x4d302c).fillCircle(avatar - 5, y, 1.65).fillCircle(avatar + 5, y, 1.65).fillCircle(avatar, y + 5, 1.6);
    }
    const name = [...(player?.name ?? '空座')].slice(0, 5).join('');
    this.text(x - 23, y - 16, name, 16, player?.connected === false ? '#c2c9bd' : '#fff4de');
    const descriptor = `${windLabel(seat, view.round!.banker, view.rulesVersion)}${view.round!.banker === seat ? ' · 庄' : ''}${seat === view.seat ? ' · 你' : ''}`;
    this.text(x - 23, y + 5, descriptor, 12, gilt);
    this.text(x + 63, y + 4, player?.connected === false ? '离线' : `${player?.points ?? 0}`, 13, '#fff4de').setOrigin(1, 0);
  }

  private backRow(seat: Seat, x: number, y: number, gap: number, vertical: number): void {
    const graphics = this.shape();
    const count = this.snapshot!.round!.players[seat].handCount;
    for (let index = 0; index < count; index++) {
      const left = x + index * gap * (1 - vertical);
      const top = y + index * gap * vertical;
      const w = vertical ? 23 : 12;
      const h = vertical ? 12 : 21;
      graphics.fillStyle(0x081a1b, .7).fillRoundedRect(left + 1, top + 3, w, h, 3);
      graphics.fillStyle(0xe7bd7c).fillRoundedRect(left, top + 1, w, h, 3);
      graphics.fillStyle(0x296b63).fillRoundedRect(left + 1.3, top + 1.2, w - 2.6, h - 2.6, 2);
      graphics.lineStyle(1, 0x8bc6aa, .56).strokeRoundedRect(left + 2.2, top + 2.1, w - 4.4, h - 4.7, 2);
    }
  }

  private discards(seats: Seat[]): void {
    const round = this.snapshot!.round!;
    const origins = [[447, 345], [732, 147], [447, 94], [264, 147]];
    seats.forEach((seat, index) => {
      const [x, y] = origins[index];
      const isSide = index % 2 === 1;
      const columns = isSide ? 5 : 8;
      const size = index === 2 ? 18 : 21;
      round.players[seat].discards.forEach((tile, discard) => {
        const row = Math.floor(discard / columns);
        const column = discard % columns;
        const spacing = isSide ? 26 : 29;
        const pending = round.pending?.kind === 'discard' && round.pending.from === seat && discard === round.players[seat].discards.length - 1;
        this.tile(x + column * spacing, y + row * (index === 2 ? 24 : 28), tile, size, tile === round.joker, pending);
      });
    });
  }

  private melds(melds: PublicMeld[], x: number, y: number, w: number, joker?: Tile): void {
    let totalWidth = 0;
    for (const meld of melds) totalWidth += (meld.kind === 'pong' ? 3 : 4) * (w + 1) + 5;
    let left = x - totalWidth / 2;
    for (const meld of melds) {
      const count = meld.kind === 'pong' ? 3 : 4;
      for (let index = 0; index < count; index++) {
        this.tile(left, y, meld.tile, w, meld.tile !== null && meld.tile === joker);
        left += w + 1;
      }
      left += 5;
    }
  }

  private tile(x: number, y: number, tile: Tile | null, w: number, joker = false, selected = false): Phaser.GameObjects.Container {
    const card = this.add.container(x, y);
    this.drawLayer!.add(card);
    const face = this.add.graphics();
    card.add(face);
    const h = Math.round(w * 1.29);
    const r = w * .13;
    face.fillStyle(0x06171c, .68).fillRoundedRect(-w / 2 + 1, -h / 2 + w * .18, w + 1, h, r);
    if (selected) {
      face.fillStyle(gold, .32).fillRoundedRect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 12, r + 3);
      face.lineStyle(2, gold).strokeRoundedRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 8, r + 1);
    }
    face.fillStyle(0x2f7867).fillRoundedRect(-w / 2, -h / 2 + w * .14, w, h, r);
    face.fillStyle(0xbf9258).fillRoundedRect(-w / 2, -h / 2 + w * .075, w, h, r);
    face.fillStyle(tile === null ? 0x286458 : cream).fillRoundedRect(-w / 2, -h / 2, w, h, r);
    face.lineStyle(joker ? 2 : 1, joker ? 0xce833c : 0xcfa86f).strokeRoundedRect(-w / 2 + 1, -h / 2 + 1, w - 2, h - 2, r * .75);
    face.lineStyle(1, 0xfffcf0, .86).lineBetween(-w * .32, -h / 2 + 3, w * .32, -h / 2 + 3);
    if (tile === null) return card;
    if (tile >= 9 && tile < 27) {
      const pip = pipLayouts[tile % 9 + 1];
      const bamboo = tile >= 18;
      for (const index of pip) {
        const spotX = (index % 3 - 1) * (w * .21);
        const spotY = (Math.floor(index / 3) - 1) * (h * .21);
        const color = index === 4 && (pip.length === 1 || pip.length === 5) ? 0xb84e3a : bamboo ? jade : 0x315579;
        face.fillStyle(color);
        if (bamboo) face.fillRoundedRect(spotX - w * .047, spotY - h * .091, w * .094, h * .182, w * .04);
        else face.fillCircle(spotX, spotY, w * (pip.length === 1 ? .17 : .085));
        if (!bamboo) face.fillStyle(cream).fillCircle(spotX, spotY, w * (pip.length === 1 ? .07 : .033));
      }
    } else if (tile < 9) {
      const count = this.add.text(0, -h * .15, tileLabel(tile)[0], { fontFamily: font, fontSize: w * .5, color: ink, fontStyle: 'bold' }).setOrigin(.5);
      const suit = this.add.text(0, h * .23, '萬', { fontFamily: font, fontSize: w * .4, color: '#a84233', fontStyle: 'bold' }).setOrigin(.5);
      card.add([count, suit]);
    } else if (tile === 33) {
      face.lineStyle(Math.max(1, w * .06), 0x466588).strokeRoundedRect(-w * .26, -h * .29, w * .52, h * .58, w * .05);
    } else {
      const color = tile === 31 ? '#a3392d' : tile === 32 ? '#23714b' : ink;
      card.add(this.add.text(0, 0, tileLabel(tile), { fontFamily: font, fontSize: Math.round(w * .64), color, fontStyle: 'bold' }).setOrigin(.5));
    }
    if (joker) this.inlay(face, w * .34, -h * .33, Math.max(2, w * .095), 0xcc8637);
    return card;
  }

  private die(x: number, y: number, value: number): void {
    const shape = this.shape();
    shape.fillStyle(0x081a1b, .8).fillRoundedRect(x - 15, y - 10, 30, 30, 7);
    shape.fillStyle(0xc59963).fillRoundedRect(x - 15, y - 12, 30, 30, 7);
    shape.fillStyle(cream).fillRoundedRect(x - 15, y - 15, 30, 30, 7);
    shape.lineStyle(1, 0xfffefa).lineBetween(x - 8, y - 13, x + 8, y - 13);
    shape.fillStyle(value === 1 || value === 4 ? 0xaa4430 : 0x304e43);
    for (const index of pipLayouts[value] ?? []) {
      shape.fillCircle(x + (index % 3 - 1) * 7, y + (Math.floor(index / 3) - 1) * 7, value === 1 ? 4 : 2.4);
    }
  }
}

export function createTable(parent: HTMLElement, onDiscard: (tile: Tile) => void) {
  const scene = new TeaTable(onDiscard);
  const game = new Phaser.Game({
    type: Phaser.CANVAS,
    parent,
    width,
    height,
    backgroundColor: '#0d252a',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [scene],
    audio: { noAudio: true },
  });
  return {
    update(view: RoomView) { scene.setView(view); },
    refresh() {
      if (!game.isBooted) return;
      game.scale.getParentBounds();
      game.scale.refresh();
    },
    destroy() { game.destroy(true); },
  };
}
