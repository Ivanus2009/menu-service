// index.js
require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const Redis   = require('ioredis');
const cors    = require('cors');

const {
  YT_API_KEY,
  REDIS_URL,
  MENU_TTL = 3600  // сек
} = process.env;

const redis = new Redis(REDIS_URL);
const app   = express();
app.use(cors({
    origin: '*'   
  }));
app.use(express.json());

// Функция, которая стягивает «сырые» данные
async function fetchRaw(shopGuid) {
  const base = 'https://api.ytimes.ru/ex/menu';
  const headers = {
    Accept: 'application/json',
    Authorization: YT_API_KEY
  };

  const [groupsRes, itemsRes, suppsRes] = await Promise.all([
    fetch(`${base}/v2/group/list?shopGuid=${shopGuid}`,       { headers }),
    fetch(`${base}/item/list?shopGuid=${shopGuid}`,          { headers }),
    fetch(`${base}/supplement/list?shopGuid=${shopGuid}`,    { headers }),
  ]);
  const [groups, items, supps] = await Promise.all([
    groupsRes.json(), itemsRes.json(), suppsRes.json()
  ]);
  return {
    groups:  groups.rows || [],
    items:   items.rows  || [],
    supplements: supps.rows || []
  };
}

// Собираем дерево групп + врезаем в них items и goods
function assembleMenu({ groups, items, supplements }) {
  const itemsByGroup = items.reduce((acc, cat) => {
    acc[cat.guid] = cat;
    return acc;
  }, {});

  function buildGroup(g) {
    const entry = {
      guid: g.guid,
      name: g.name,
      priority: g.priority,
      imageLink: g.imageLink,
      subgroups: (g.groupList || []).map(buildGroup),
      items:      (itemsByGroup[g.guid]?.itemList  || []),
      goods:      (itemsByGroup[g.guid]?.goodsList || [])
    };
    return entry;
  }

  return {
    tree: groups.map(buildGroup),
    supplements
  };
}

// Главная точка — кеш + отдача
app.get('/menu', async (req, res) => {
  try {
    const shopGuid = req.query.shopGuid;
    if (!shopGuid) return res.status(400).json({ error: 'shopGuid?' });

    const key = `menu:${shopGuid}`;
    let menu = await redis.get(key);
    if (menu) {
      return res.json(JSON.parse(menu));
    }

    const raw = await fetchRaw(shopGuid);
    const assembled = assembleMenu(raw);
    await redis.set(key, JSON.stringify(assembled), 'EX', MENU_TTL);
    res.json(assembled);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`menu-service listening on ${PORT}`));
