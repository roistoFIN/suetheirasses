import GameTimelineView from './GameTimelineView';

/** AFTERMATH — the finished-game replay, for everyone (winner and spectators alike): the
 * same Civilization-style timeline used for live spectating, just fixed at the final
 * round rather than following a live round. Scrubbing to the final round IS the final-
 * standings view — there's no separate table. See CLAUDE.md's game-timeline section. */
export default function GameOver() {
  return <GameTimelineView mode="finished" />;
}
