// The frontend's lib/categories.ts. Labels are used to search transactions by category name.
export const CATEGORIES = [
  { id: 'food', label: 'Food' },
  { id: 'transport', label: 'Transport' },
  { id: 'printing', label: 'Printing & photocopy' },
  { id: 'data', label: 'Data & airtime' },
  { id: 'personal-care', label: 'Personal care' },
  { id: 'giving', label: 'Church or mosque giving' },
  { id: 'outings', label: 'Outings' },
  { id: 'others', label: 'Others' },
];

export const CATEGORY_IDS = CATEGORIES.map((category) => category.id);

/** Ids of the categories whose name contains `text`, ignoring case. */
export function categoriesMatching(text) {
  const needle = text.toLowerCase();
  return CATEGORIES.filter((category) => category.label.toLowerCase().includes(needle)).map(
    (category) => category.id,
  );
}
