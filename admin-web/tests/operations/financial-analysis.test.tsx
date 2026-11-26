import {useState} from 'react';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import {FinancialAnalysisTable, type FinancialAnalysisTableProps, type FinancialColumn} from '../../src/features/operations/FinancialAnalysisTable';

interface Row {id:string; payer:string | null; amount:number | null; date:string | number | null; state:string}
const rows: readonly Row[] = [
  {id:'One',payer:'Alice',amount:10,date:'2026-11-23T21:59:59.999Z',state:'posted'},
  {id:'Two',payer:'Éric',amount:2,date:'2026-11-23T22:00:00.000Z',state:'posted'},
  {id:'Three',payer:'Éric',amount:2,date:'2026-11-25T01:59:59.999+04:00',state:'pending'},
  {id:'Four',payer:' ',amount:null,date:'2026-11-25T00:00:00.000+02:00',state:'queued'},
  {id:'Five',payer:null,amount:0,date:null,state:'pending'},
  {id:'Six',payer:'Amina',amount:120,date:Date.parse('2026-11-24T15:00:00Z'),state:'queued'},
];
const columns: FinancialColumn<Row>[] = [
  {key:'id',label:'Reference',kind:'text',value:r=>r.id},
  {key:'payer',label:'Payer',kind:'text',value:r=>r.payer},
  {key:'amount',label:'Amount',kind:'number',value:r=>r.amount},
  {key:'date',label:'Date',kind:'date',value:r=>r.date},
  {key:'state',label:'Status',kind:'category',value:r=>r.state,options:[{value:'posted',label:'Posted'},{value:'pending',label:'Pending'},{value:'queued',label:'Queued'}]},
];
const key = (row: Row) => row.id;
const sample = (options: Partial<FinancialAnalysisTableProps<Row>> = {}) => <FinancialAnalysisTable rows={rows} columns={columns}
  rowKey={key} label="Payments" pageSize={2} {...options}/>;
const ids = () => within(screen.getByRole('table',{name:'Payments'})).getAllByRole('row').slice(1)
  .map(row=>within(row).getAllByRole('cell')[0].textContent);
const button = (name: string) => screen.getByRole('button',{name});
async function filter(label: string) {
  const user=userEvent.setup();
  await user.click(button('Filter ' + label));
  return {user,dialog:within(screen.getByRole('dialog',{name:'Filter ' + label}))};
}
describe('financial analysis grid',()=>{
  it('keeps every declared category selectable when the server returns only the selected value',async()=>{
    const onCriteria=vi.fn();
    const remote={filters:new Map(),sort:{key:'state',direction:'asc' as const},total:rows.length,matching:1,onCriteria};
    render(sample({rows:[rows[0]],remote}));
    const {user,dialog}=await filter('Status');
    await user.click(dialog.getByRole('checkbox',{name:'Queued'}));
    await user.click(dialog.getByRole('button',{name:'Apply filter'}));
    expect(onCriteria.mock.calls[0][0].get('state').choices).toEqual(['queued']);
  });
  it('exposes separate keyboard buttons at each header; sorts amounts numerically in both directions, with stable ties and blanks last',async()=>{
    const user=userEvent.setup();
    render(sample({pageSize:10}));
    for (const column of columns) {
      const header=within(screen.getByRole('columnheader',{name:column.label}));
      expect(header.getByRole('button',{name:'Filter '+column.label})).toHaveAttribute('aria-haspopup','dialog');
      expect(header.getByRole('button',{name:'Sort '+column.label+' ascending'})).toBeVisible();
    }
    button('Sort Amount ascending').focus(); await user.keyboard('{Enter}');
    expect(ids()).toEqual(['Five','Two','Three','One','Six','Four']);
    expect(screen.getByRole('columnheader',{name:'Amount'})).toHaveAttribute('aria-sort','ascending');
    await user.keyboard(' ');
    expect(ids()).toEqual(['Six','One','Two','Three','Five','Four']);
    expect(screen.getByRole('columnheader',{name:'Amount'})).toHaveAttribute('aria-sort','descending');
  });

  it('filters complete off-page records, combines independent columns, and summarizes all matches before pagination',async()=>{
    const summary=vi.fn((matching:readonly Row[])=> <output aria-label="Total matched">{matching.reduce((sum,r)=>sum+(r.amount??0),0)}</output>);
    render(sample({pageSize:1,summary}));
    expect(ids()).toEqual(['One']);
    expect(screen.getByLabelText('Total matched')).toHaveTextContent('134');
    const {user,dialog}=await filter('Payer');
    await user.type(dialog.getByRole('searchbox',{name:'Contains'}),'ERIC');
    await user.click(dialog.getByRole('button',{name:'Apply filter'}));
    expect(ids()).toEqual(['Two']);
    expect(screen.getByText('2 of 6 records')).toBeVisible();
    expect(screen.getByLabelText('Total matched')).toHaveTextContent('4');
    await user.click(button('Next page')); expect(ids()).toEqual(['Three']);
    const {dialog:status}=await filter('Status');
    expect(status.getAllByRole('checkbox')).toHaveLength(3);
    await user.click(status.getByRole('checkbox',{name:'Pending'}));
    await user.click(status.getByRole('button',{name:'Apply filter'}));
    expect(ids()).toEqual(['Three']);
    expect(summary.mock.calls.at(-1)?.[0].map(r=>r.id)).toEqual(['Three']);
    await user.click(button('Clear all filters')); expect(ids()).toEqual(['One']);
  });

  it('uses inclusive Kigali day ranges and sorts equivalent offset/epoch representations by their true instant',async()=>{
    render(sample({pageSize:10}));
    const {user,dialog}=await filter('Date');
    fireEvent.change(dialog.getByLabelText('From'),{target:{value:'2026-11-24'}});
    fireEvent.change(dialog.getByLabelText('Through'),{target:{value:'2026-11-24'}});
    await user.click(dialog.getByRole('button',{name:'Apply filter'}));
    expect(ids()).toEqual(['Two','Three','Six']);
    await user.click(button('Sort Date ascending')); expect(ids()).toEqual(['Two','Six','Three']);
    await user.click(button('Sort Date descending')); expect(ids()).toEqual(['Three','Six','Two']);
  });

  it('validates inclusive numeric bounds, supports exact zero and blanks, and clears zero-result filters without hiding controls',async()=>{
    render(sample({pageSize:10}));
    const {user,dialog}=await filter('Amount');
    fireEvent.change(dialog.getByLabelText('Minimum'),{target:{value:'10'}});
    fireEvent.change(dialog.getByLabelText('Maximum'),{target:{value:'2'}});
    await user.click(dialog.getByRole('button',{name:'Apply filter'}));
    expect(dialog.getByRole('alert')).toHaveTextContent('maximum');
    expect(dialog.getByLabelText('Maximum')).toHaveAttribute('aria-invalid','true');
    fireEvent.change(dialog.getByLabelText('Minimum'),{target:{value:'0'}});
    fireEvent.change(dialog.getByLabelText('Maximum'),{target:{value:'0'}});
    await user.click(dialog.getByRole('button',{name:'Apply filter'})); expect(ids()).toEqual(['Five']);
    const {dialog:empty}=await filter('Amount');
    await user.click(empty.getByRole('radio',{name:'Blank only'})); await user.click(empty.getByRole('button',{name:'Apply filter'}));
    expect(ids()).toEqual(['Four']);
    const {dialog:payer}=await filter('Payer');
    await user.type(payer.getByLabelText('Contains'),'Nobody'); await user.click(payer.getByRole('button',{name:'Apply filter'}));
    expect(screen.getByText('No matching records.')).toBeVisible();
    await user.click(button('Clear all filters')); expect(ids()).toHaveLength(6);
  });

  it('combines multiple category choices and preserves an already-applied filter on cancel or Escape',async()=>{
    render(sample({pageSize:10,initialFilters:{state:'pending',missing:'no effect'}}));
    expect(ids()).toEqual(['Three','Five']);
    const trigger=button('Filter Status');
    const {dialog,user}=await filter('Status');
    await user.click(dialog.getByRole('checkbox',{name:'Posted'}));
    await user.keyboard('{Escape}'); expect(trigger).toHaveFocus(); expect(ids()).toEqual(['Three','Five']);
    const {dialog:again}=await filter('Status');
    expect(again.getByRole('checkbox',{name:'Posted'})).not.toBeChecked();
    await user.click(again.getByRole('checkbox',{name:'Queued'})); await user.click(again.getByRole('button',{name:'Apply filter'}));
    expect(ids()).toEqual(['Three','Four','Five','Six']);
    const {dialog:clear}=await filter('Status');
    await user.click(clear.getByRole('button',{name:'Clear filter'})); expect(ids()).toHaveLength(6);
    const {dialog:present}=await filter('Payer');
    await user.click(present.getByRole('radio',{name:'Non-blank only'})); await user.click(present.getByRole('button',{name:'Apply filter'}));
    expect(ids()).toEqual(['One','Two','Three','Six']);
  });

  it('reveals an externally selected page and preserves inline drafts, active filters and trigger focus when expanding/restoring the table',async()=>{
    const user=userEvent.setup();
    const item={key:'Six',content:<label>Review note<input defaultValue="" /></label>};
    render(sample({expanded:item,initialFilters:{state:'queued'},pageSize:1}));
    await waitFor(()=>expect(screen.getByText('Page 2 of 2')).toBeVisible());
    await user.type(screen.getByRole('textbox',{name:'Review note'}),'unsaved');
    await user.click(button('Expand table'));
    const expanded=screen.getByRole('dialog',{name:'Payments'});
    expect(within(expanded).getByLabelText('Review note')).toHaveValue('unsaved');
    const {dialog}=await filter('Status');
    expect(dialog.getByRole('checkbox',{name:'Queued'})).toBeChecked();
    await user.keyboard('{Escape}'); expect(expanded).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button('Expand table')).toHaveFocus();
    expect(screen.getByLabelText('Review note')).toHaveValue('unsaved');
  });

  it('clamps controlled bookmarks, emits legal page changes and resets after filtering',async()=>{
    const user=userEvent.setup(), changed=vi.fn();
    function Route() {
      const [page,setPage]=useState(99);
      return sample({page,onPageChange:value=>{changed(value);setPage(value);}});
    }
    render(<Route />);
    await waitFor(()=>expect(changed).toHaveBeenCalledWith(3));
    expect(ids()).toEqual(['Five','Six']);
    expect(button('Next page')).toBeDisabled();
    await user.click(button('Previous page')); expect(changed).toHaveBeenLastCalledWith(2);
    const {dialog}=await filter('Status');
    await user.click(dialog.getByRole('checkbox',{name:'Pending'})); await user.click(dialog.getByRole('button',{name:'Apply filter'}));
    expect(changed).toHaveBeenLastCalledWith(1);
    expect(ids()).toEqual(['Three','Five']);
  });

  it('shows the actual criteria in each editable chip and keeps toolbar actions available for empty results',async()=>{
    const refreshed=vi.fn();
    render(sample({initialFilters:{state:'pending'},actions:<button onClick={refreshed}>Refresh</button>}));
    expect(button('Edit Status filter')).toHaveTextContent('Status · Pending');
    const {dialog,user}=await filter('Amount');
    fireEvent.change(dialog.getByLabelText('Minimum'),{target:{value:'2000'}});
    fireEvent.change(dialog.getByLabelText('Maximum'),{target:{value:'3000'}});
    await user.click(dialog.getByRole('button',{name:'Apply filter'}));
    expect(button('Edit Amount filter')).toHaveTextContent('Amount ≥ 2,000 · ≤ 3,000');
    expect(button('Edit Amount filter')).toHaveAccessibleDescription('≥ 2,000 · ≤ 3,000');
    expect(screen.getByText('No matching records.')).toBeVisible();
    await user.click(button('Refresh')); expect(refreshed).toHaveBeenCalledOnce();
    await user.click(button('Edit Amount filter'));
    const reopened=within(screen.getByRole('dialog',{name:'Filter Amount'}));
    await user.click(reopened.getByRole('radio',{name:'Blank only'}));
    await user.click(reopened.getByRole('button',{name:'Apply filter'}));
    expect(button('Edit Amount filter')).toHaveTextContent('Amount · Blank');
  });

  it('uses radio choices in the popup and restores focus to the column after clearing a filter chip',async()=>{
    render(sample({pageSize:10}));
    const {dialog,user}=await filter('Payer');
    expect(dialog.queryByRole('combobox')).not.toBeInTheDocument();
    const values=within(dialog.getByRole('group',{name:'Values'}));
    const all=values.getByRole('radio',{name:'All values'});
    expect(all).toBeChecked();
    all.focus();await user.keyboard('{ArrowRight}');
    expect(values.getByRole('radio',{name:'Blank only'})).toBeChecked();
    await user.click(dialog.getByRole('button',{name:'Apply filter'}));
    await user.click(button('Edit Payer filter'));
    await user.click(screen.getByRole('button',{name:'Clear filter'}));
    expect(button('Filter Payer')).toHaveFocus();
    expect(ids()).toHaveLength(6);
  });
});
