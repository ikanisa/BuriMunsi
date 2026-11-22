import {act, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {AdminUpdateNotice} from '../../src/layout/AdminUpdateNotice';

function worker(state: ServiceWorkerState, script = '/custom-sw.js') {
  return Object.assign(new EventTarget(), {state, scriptURL: new URL(script, location.origin).href});
}

function fixture(scope = '/', deferred = false) {
  const current = worker('activated');
  const registration = Object.assign(new EventTarget(), {
    scope: new URL(scope, location.origin).href,
    active: current,
    installing: null as ReturnType<typeof worker> | null,
    waiting: null as ReturnType<typeof worker> | null,
  });
  let resolve!: (value: typeof registration) => void;
  const ready = new Promise<typeof registration>(done => {resolve = done;});
  const serviceWorker = Object.assign(new EventTarget(), {ready, controller: current});
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'serviceWorker', {configurable: true, value: serviceWorker});
  if (!deferred) resolve(registration);
  return {registration, serviceWorker, resolve: () => resolve(registration)};
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.unstubAllGlobals();
});

it('announces an installed update after it waits and clears a replaced candidate', async () => {
  const {registration, serviceWorker} = fixture();
  render(<AdminUpdateNotice />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
  const candidate = worker('installing');
  act(() => {
    registration.installing = candidate;
    registration.dispatchEvent(new Event('updatefound'));
  });
  expect(screen.queryByRole('status')).toBeNull();
  act(() => {
    candidate.state = 'installed';
    registration.installing = null;
    registration.waiting = candidate;
    candidate.dispatchEvent(new Event('statechange'));
  });
  expect(screen.getByRole('status')).toHaveTextContent('Admin update ready. Finish open work.');
  expect(screen.getByText('about:blank')).toBeVisible();
  act(() => {
    serviceWorker.controller = worker('activated');
    serviceWorker.dispatchEvent(new Event('controllerchange'));
  });
  expect(screen.queryByRole('status')).toBeNull();
});

it.each([['/other/', '/custom-sw.js'], ['/', '/different-sw.js']])('ignores out-of-scope worker %s %s', async (scope, script) => {
  const {registration} = fixture(scope);
  registration.waiting = worker('installed', script);
  render(<AdminUpdateNotice />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
});

it('does not subscribe to a registration resolved after disposal', async () => {
  const {registration, serviceWorker, resolve} = fixture('/', true);
  const attach = vi.spyOn(registration, 'addEventListener');
  const detach = vi.spyOn(serviceWorker, 'removeEventListener');
  const view = render(<AdminUpdateNotice />);
  view.unmount();
  await act(async () => resolve());
  expect(attach).not.toHaveBeenCalled();
  expect(detach).toHaveBeenCalledWith('controllerchange', expect.any(Function));
});
