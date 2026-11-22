interface AdminBrand {
  id: string;
  product: string;
  name: string;
  description: string;
  icon: string;
  iconSha256: string;
  iconSize: string;
  iconPurpose: string;
  support: {phone: string; number: string; url: string};
}

export const burimunsiAdminBrand: AdminBrand;
