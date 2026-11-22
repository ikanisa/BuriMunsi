const phone = '+250 788 767 816';
const digits = phone.replace(/[+ ]/g, '');

export const burimunsiSupport = Object.freeze({phone, number: '+' + digits, url: 'https://wa.me/' + digits});
