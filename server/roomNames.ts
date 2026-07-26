const ADJECTIVES = [
  'chrome', 'neon', 'static', 'burned', 'mirrored', 'rain-slick', 'sodium',
  'cobalt', 'phosphor', 'glitched', 'derelict', 'orbital', 'monofilament',
  'black-clinic', 'dead-channel', 'carbon', 'strobed', 'jury-rigged',
  'zero-day', 'grey-market', 'null', 'vatgrown', 'polycarbon', 'ghosted',
];

const PLACES = [
  'arcology', 'datavault', 'backroom', 'node', 'uplink', 'den', 'silo',
  'relay', 'enclave', 'motel', 'pier', 'bazaar', 'loft', 'substrate',
  'terminal', 'exchange', 'annex', 'sprawl', 'chophouse', 'coffin',
  'stack', 'junkyard', 'clinic', 'arcade', 'freight', 'switchyard',
];

const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

/** Jitsi-style generated construct names, sprawl edition: neon-static-relay */
export function generateRoomName(taken: (name: string) => boolean): string {
  for (let i = 0; i < 50; i++) {
    const name = `${pick(ADJECTIVES)}-${pick(ADJECTIVES)}-${pick(PLACES)}`;
    if (!taken(name)) return name;
  }
  return `${pick(ADJECTIVES)}-${pick(PLACES)}-${Math.floor(Math.random() * 9999)}`;
}
