import { z } from 'zod';
import { classify, type Slot } from './model.js';

const savedSlot = z.object({ status: z.enum(['AVAILABLE','OCCUPIED']), count: z.number().int().nonnegative(), everAvailable: z.boolean() });
export const stateSchema = z.object({ version: z.literal(1), slots: z.record(z.string(), savedSlot) });
export type State = z.infer<typeof stateSchema>;
export type Event = { type: 'AVAILABLE_NEW'|'AVAILABLE_RETURNED'|'AVAILABLE_UNCHANGED'|'AVAILABLE_GONE'; slot: Slot };
export function update(state: State, park: string, date: string, slots: Slot[], log: (message: string) => void): Event[] {
  const events: Event[] = [];
  for (const slot of slots) {
    const status = classify(slot), key = `${park}|${date}|${slot.baslangic}|${slot.bitis}`, old = state.slots[key];
    if (status === 'UNKNOWN') { log(`Невідомий стан ${date} ${slot.baslangic}–${slot.bitis}: kalan=${slot.kalan}, acik=${slot.acik}, kapali=${slot.kapali}`); continue; }
    if (status === 'AVAILABLE') {
      const type = old?.status === 'AVAILABLE' ? 'AVAILABLE_UNCHANGED' : old?.everAvailable ? 'AVAILABLE_RETURNED' : 'AVAILABLE_NEW';
      events.push({ type, slot });
      if (old?.status === 'AVAILABLE' && old.count !== slot.kalan) log(`${date} ${slot.baslangic}: кількість змінилася ${old.count} → ${slot.kalan}`);
    } else if (old?.status === 'AVAILABLE') events.push({ type: 'AVAILABLE_GONE', slot });
    state.slots[key] = { status, count: slot.kalan, everAvailable: status === 'AVAILABLE' || !!old?.everAvailable };
  }
  return events;
}
export function istanbulDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0,10) === s;
}
export function fallbackDates(days: number, explicit: string[], now = new Date()): string[] {
  if (explicit.length) return [...new Set(explicit)];
  const base = new Date(`${istanbulDate(now)}T00:00:00Z`);
  return Array.from({length:days}, (_, i) => { const d = new Date(base); d.setUTCDate(d.getUTCDate()+i); return d.toISOString().slice(0,10); });
}
