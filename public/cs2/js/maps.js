/* Карты CS2: внутреннее имя → как называть в эфире.
   Используется и оверлеем, и пультом. Добавить карту — одна строка. */

window.CS2_MAPS = [
  ['de_ancient', 'Ancient'],
  ['de_anubis', 'Anubis'],
  ['de_dust2', 'Dust II'],
  ['de_inferno', 'Inferno'],
  ['de_mirage', 'Mirage'],
  ['de_nuke', 'Nuke'],
  ['de_overpass', 'Overpass'],
  ['de_train', 'Train'],
  ['de_vertigo', 'Vertigo'],
  ['cs_office', 'Office'],
  ['cs_italy', 'Italy']
];

window.mapLabel = function mapLabel(id) {
  if (!id) return '';
  const short = String(id).split('/').pop();
  const hit = window.CS2_MAPS.find(([key]) => key === short);
  if (hit) return hit[1];
  return short.replace(/^(de|cs|ar)_/, '').replace(/^\w/, c => c.toUpperCase());
};
