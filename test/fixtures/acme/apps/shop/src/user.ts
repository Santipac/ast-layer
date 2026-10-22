export async function getMe(token: string, baseUrl: string) {
  const url = `${baseUrl}/users/me`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error("Could not load user");
  }
  const data = await response.json();
  return { id: data.id, name: data.name, email: data.email, avatar: data.avatar, roles: data.roles };
}
