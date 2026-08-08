SELECT e.type, COUNT(*) AS rows_with_type FROM equipment e GROUP BY e.type ORDER BY rows_with_type DESC;
