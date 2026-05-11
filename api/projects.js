/**
 * GET /api/projects
 * Returns all projects and their indexed files from Supabase.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Thiếu Supabase config' });

  const response = await fetch(
    `${supabaseUrl}/rest/v1/documents?select=file_name,project&order=project,file_name`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
  );

  if (!response.ok) return res.status(500).json({ error: 'Supabase error' });

  const rows = await response.json();

  // Group rows by project → unique files with chunk counts
  const projectMap = {};
  for (const row of rows) {
    const proj = row.project || 'default';
    const file = row.file_name;
    if (!projectMap[proj]) projectMap[proj] = {};
    if (!projectMap[proj][file]) projectMap[proj][file] = { fileName: file, chunks: 0 };
    projectMap[proj][file].chunks++;
  }

  const projects = Object.entries(projectMap).map(([name, filesObj]) => ({
    name,
    files: Object.values(filesObj)
  }));

  return res.status(200).json(projects);
};
