export const toEnum = (arr) => {
  const enumObj = {}
  for (const variant of arr) {
    enumObj[variant] = variant
  }
  return enumObj
}
