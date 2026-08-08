SELECT t.trailer_number, COUNT(*) AS uses,
       MIN(COALESCE(t.date1, DATE(t.date_created))) AS first_seen,
       MAX(COALESCE(t.date1, DATE(t.date_created))) AS last_seen
FROM trailer_tracking_1 t
WHERE t.trailer_number LIKE '%-ACC'
GROUP BY t.trailer_number ORDER BY uses DESC;
