document.addEventListener('DOMContentLoaded', () => {
  const appDiv = document.createElement('div');
  appDiv.className = 'App';

  const header = document.createElement('header');
  header.className = 'App-header';

  const paragraph = document.createElement('p');
  paragraph.textContent = 'Edit src/App.js and save to reload.';

  header.appendChild(paragraph);
  appDiv.appendChild(header);

  document.getElementById('root').appendChild(appDiv);
});
