import {useId, useState, useSyncExternalStore} from 'react';
import {adminBrand} from '../branding';
import {getAppInstallation, installInstructions} from '../pwa-install';
import {Icon} from './Icon';
import './installApp.css';

export function InstallApp() {
  const installation = getAppInstallation();
  const state = useSyncExternalStore(installation.subscribe, installation.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const instructionsId = useId();
  if (state === 'installed') return null;
  // Keep instructions open if the browser offers its prompt while they are being read.
  const manual = state === 'help' || expanded;
  function activate() {
    if (manual) {
      setExpanded(value => !value);
    } else if (state === 'available') {
      setExpanded(false);
      void installation.request().then(outcome => {if (outcome === 'help') setExpanded(true);});
    }
  }
  return <>
    <button className="admin-install-button" type="button" onClick={activate}
      aria-disabled={state === 'prompting' || undefined} aria-expanded={manual ? expanded : undefined}
      aria-controls={expanded ? instructionsId : undefined}>
      <Icon name="download" />{manual ? 'How to install' : 'Install'} {adminBrand.name}
    </button>
    {expanded && <p id={instructionsId} className="admin-install-instructions">{installInstructions(navigator)}</p>}
  </>;
}
