// In test-support/, not test/, so node's --test glob never picks this up as a test itself.

let counter = 0;

// A WidgetEvent-shaped plain object with sane defaults, overridden by whatever fields the caller passes.
export function ev(overrides = {}) {
  counter += 1;
  return {
    id: `ev-${counter}`,
    title: 'Event',
    start: '2026-10-01T09:00:00',
    end: '2026-10-01T10:00:00',
    allDay: false,
    calId: 'f1',
    calendar: 'Test Calendar',
    color: '#9333ea',
    location: '',
    notes: '',
    meetingUrl: null,
    url: null,
    important: false,
    ...overrides,
  };
}
