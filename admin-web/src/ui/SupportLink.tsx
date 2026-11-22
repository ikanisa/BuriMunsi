import {adminBrand} from '../branding';

export function SupportLink() {
  const {phone, url} = adminBrand.support;
  return <a className="admin-btn admin-btn--secondary" href={url} target="_blank" rel="noopener noreferrer">WhatsApp support · {phone}</a>;
}
