export async function loadDirectory(files) {
  const filesMap = {};

  // 'files' is an array of File objects from an <input type="file" webkitdirectory />
  // Or it can be from the File System Access API
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const path = file.webkitRelativePath || file.name;
    
    // Ignore hidden files and directories
    if (path.includes('/.') || path.startsWith('.')) continue;

    // We only care about text files. We'll read everything as text for now.
    const text = await readFileAsText(file);
    filesMap[path] = text;
  }
  
  return filesMap;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
