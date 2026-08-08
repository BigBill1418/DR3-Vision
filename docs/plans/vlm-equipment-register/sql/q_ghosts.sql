SELECT t.trailer_number, COUNT(*) AS uses,
       MIN(COALESCE(t.date1, DATE(t.date_created))) AS first_seen,
       MAX(COALESCE(t.date1, DATE(t.date_created))) AS last_seen
FROM trailer_tracking_1 t
WHERE t.trailer_number REGEXP '^[0-9]+$'
  AND NOT EXISTS (SELECT 1 FROM equipment e WHERE e.unit = t.trailer_number)
GROUP BY t.trailer_number ORDER BY uses DESC;
