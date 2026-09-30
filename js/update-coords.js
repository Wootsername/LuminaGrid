const coords = {
  1: { latitude: 10.32430, longitude: 123.88345 },
  2: { latitude: 10.32286, longitude: 123.88388 },
  3: { latitude: 10.32214, longitude: 123.88402 },
  4: { latitude: 10.31548, longitude: 123.88550 }
};

const updatePromises = Object.keys(coords).map(id => {
  return fetch(`https://luminagrid-cf8c4-default-rtdb.asia-southeast1.firebasedatabase.app/streetlight/${id}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(coords[id])
  }).then(res => res.json());
});

Promise.all(updatePromises)
  .then(results => console.log('Successfully updated coordinates:', results))
  .catch(err => console.error('Error updating coordinates:', err));
