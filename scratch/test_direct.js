async function run() {
  const url = 'https://evolutiom.autori-studio.com/instance/connectionState/autoRI-studio';
  const token = 'gKQLw9R6sk0BacPNTOoW6NIFafQxN8Ju';
  
  console.log('Fetching:', url);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': token
      }
    });
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Body:', text);
  } catch (err) {
    console.error('Error:', err);
  }
}
run();
