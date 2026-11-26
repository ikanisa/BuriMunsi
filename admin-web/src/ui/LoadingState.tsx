export type LoadingLayout = 'inline' | 'workspace' | 'home' | 'table' | 'details';

interface LoadingProps {
  label?: string;
  layout?: LoadingLayout;
  homeCards?: readonly [number, number];
}

const cardSlots = [0, 1, 2];
const rowSlots = [0, 1, 2, 3];

function TableShape() {
  return <div className="admin-loading-table">
    {rowSlots.map(row => <div className="admin-loading-row" key={row}>
      <span /><span /><span /><span />
    </div>)}
  </div>;
}

function DetailsShape() {
  return <div className="admin-loading-details">
    <span className="admin-loading-title" />
    <div className="admin-loading-facts">{rowSlots.map(field =>
      <div className="admin-loading-field" key={field}><span /><span /></div>)}</div>
  </div>;
}

function HomeShape({cards}: {cards: readonly [number, number]}) {
  return <>{cards.map((count, index) => count > 0 && <div className="admin-loading-metrics" key={index}>
    {cardSlots.slice(0, count).map(card => <div className="admin-loading-metric" key={card}><span /><span /></div>)}
  </div>)}{cards[1] > 0 && <TableShape />}</>;
}

export function LoadingState({label = 'Loading', layout = 'inline', homeCards = [3, 3]}: LoadingProps) {
  return <div className="admin-loading" data-loading-layout={layout} role="status" aria-live="polite" aria-atomic="true">
    {layout === 'inline' ? <><span className="admin-spinner" aria-hidden="true" /><span>{label}</span></> : <>
      <span className={layout === 'workspace' ? 'admin-loading-caption' : 'admin-sr-only'}>{label}</span>
      <div className="admin-loading-shapes" aria-hidden="true">
        {layout === 'home' ? <HomeShape cards={homeCards} /> : layout === 'table' ? <TableShape /> : <DetailsShape />}
      </div>
    </>}
  </div>;
}
