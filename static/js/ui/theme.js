/**
 * Sandeshika — presentation constants.
 *
 * Colours and labels were previously inlined at each use site, so the same
 * category was one hex value in the bar chart and another in the transaction
 * list. One table, used everywhere.
 */

/** @type {Record<string, string>} */
export const CAT_COLOR = {
  food: '#F4A62E', groceries: '#1FAE7A', transport: '#4C8DF6', shopping: '#B569E8',
  bills: '#E8635A', entertainment: '#E85AA8', health: '#42C0C0', education: '#7B8DF6',
  travel: '#F27B3D', transfer: '#8896A6', investment: '#12805A', income: '#2FBF71',
  other: '#A0AAB6',
};

export const NEUTRAL = '#A0AAB6';
export const GOOD = '#1FAE7A';
export const WARN = '#F4A62E';
export const BAD = '#E8635A';
export const INFO = '#4C8DF6';

/** A category that does not exist yet (the user just made one) still gets a dot. */
export const catColor = (c) => CAT_COLOR[c] || NEUTRAL;

/** @type {Record<string, string>} */
export const BOX_COLOR = {
  transactions: GOOD, bills: BAD, updates: INFO,
  promotions: WARN, personal: '#B569E8', spam: '#8896A6',
};

export const boxColor = (tab) => BOX_COLOR[tab] || NEUTRAL;

/** @type {Record<string, string>} */
export const BOX_EMPTY = {
  transactions: 'No transactions in the loaded messages.',
  bills: 'No bills or due dates found.',
  updates: 'No delivery, travel or service updates.',
  promotions: 'No promotional messages. Enjoy the quiet.',
  personal: 'No personal messages — these come from numeric senders.',
  spam: 'Nothing flagged as spam.',
};

/** @type {Record<string, string>} */
export const KIND_LABEL = {
  expense: 'Spending',
  income: 'Income',
  refund: 'Refund',
  transfer: 'Transfer (own accounts)',
};

/** @type {Record<string, string>} */
export const VIEW_TITLE = {
  overview: 'Dashboard', daily: 'Day by day', transactions: 'All transactions',
  bills: 'Bills & due dates', inbox: 'Inbox', ask: 'Ask a question',
  setup: 'Setup & learning', day: 'Day by day', txn: 'Transaction', list: 'Details',
};
